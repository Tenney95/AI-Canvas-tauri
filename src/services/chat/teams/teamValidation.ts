import type { AgentTeamRun, ReviewDecision, ReviewFinding, TeamArtifactReference, TeamDecisionReport, TeamReviewReport } from '../../../types/agentTeam';

/** 只消费已完成的上游，不能因为下游 pending 节点存在就绕过结构产物。 */
export function getTeamSourceArtifact(
  run: Pick<AgentTeamRun, 'stages' | 'artifacts' | 'inputArtifact'> & Partial<Pick<AgentTeamRun, 'version' | 'graph'>>,
  sourceTaskId?: string,
): TeamArtifactReference {
  if (run.version === 2) {
    if (sourceTaskId) {
      const stage = run.stages.find((item) => item.id === sourceTaskId && item.status === 'completed');
      const reference = run.artifacts.find((item) => item.id === stage?.artifactId && item.stageId === sourceTaskId
        && ['outline', 'draft', 'revision'].includes(item.kind));
      if (!reference) throw new Error('指定的上游正文未完成或产物缺失，不能读取其他分支替代');
      return reference;
    }
    return run.artifacts.find((artifact) => artifact.kind === 'original')
      ?? run.artifacts.find((artifact) => artifact.kind === 'draft' && artifact.stageId === 'source') ?? run.inputArtifact;
  }
  for (const stageId of ['draft', 'structure']) {
    const stage = run.stages.find((item) => item.id === stageId && item.status === 'completed');
    if (!stage) continue;
    const reference = run.artifacts.find((artifact) => artifact.id === stage.artifactId && artifact.stageId === stageId
      && artifact.kind === (stageId === 'draft' ? 'draft' : 'outline'));
    if (!reference) throw new Error('上游阶段产物缺失，不能回退原材料继续生成');
    return reference;
  }
  return run.artifacts.find((artifact) => artifact.kind === 'original')
    ?? run.artifacts.find((artifact) => artifact.kind === 'draft' && artifact.stageId === 'source') ?? run.inputArtifact;
}

/** 已验证的同稿澄清只失效裁决与修订；其他追加保守失效全部阶段。 */
export function getTeamAmendmentStageIds(
  run: Pick<AgentTeamRun, 'stages' | 'artifacts' | 'inputArtifact'>,
  decision?: TeamDecisionReport,
  reviews: TeamReviewReport[] = [],
): string[] {
  const all = run.stages.map((stage) => stage.id);
  const source = getTeamSourceArtifact(run);
  const upstreamComplete = run.stages.every((stage) => stage.id === 'revision'
    ? stage.status === 'pending' && stage.attempts === 0 : stage.status === 'completed');
  if (upstreamComplete && decision?.decisions.some((item) => item.action === 'clarify')
    && reviews.length === 2 && reviews.every((review) => review.artifactId === source.id && review.artifactHash === source.sha256)) {
    return all.filter((id) => id === 'decision' || id === 'revision');
  }
  return all;
}

function fail(): never { throw new Error('团队结构化产物不符合约定，请修正当前阶段后继续'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail();
  return value;
}
function json(value: string): Record<string, unknown> {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(value.trim());
  try { return object(JSON.parse(fenced ? fenced[1] : value)); }
  catch { return fail(); }
}

export function validateTeamReview(textValue: string, expected: {
  artifactId: string; artifactHash: string; source: string; requirements: string; stageId: string;
}): TeamReviewReport {
  const raw = json(textValue);
  keys(raw, ['version', 'artifactId', 'artifactHash', 'findings']);
  if (raw.version !== 1 || raw.artifactId !== expected.artifactId || raw.artifactHash !== expected.artifactHash
    || !Array.isArray(raw.findings) || raw.findings.length > 12) return fail();
  const used = new Set<string>();
  const findings = raw.findings.map((value): ReviewFinding => {
    const finding = object(value);
    keys(finding, ['id', 'severity', 'location', 'evidence', 'constraint', 'suggestion']);
    const id = text(finding.id, 80);
    if (!id.startsWith(`${expected.stageId}-`) || used.has(id)) return fail();
    used.add(id);
    if (finding.severity !== 'critical' && finding.severity !== 'major' && finding.severity !== 'minor') return fail();
    const evidence = text(finding.evidence, 1000);
    const constraint = text(finding.constraint, 1000);
    if (!expected.source.includes(evidence)
      || (constraint !== '质量建议' && !expected.requirements.includes(constraint))) return fail();
    return { id, severity: finding.severity, location: text(finding.location, 300), evidence,
      constraint, suggestion: text(finding.suggestion, 2000) };
  });
  return { version: 1, artifactId: expected.artifactId, artifactHash: expected.artifactHash, findings };
}

export function validateTeamDecision(textValue: string, findingIds: string[]): TeamDecisionReport {
  const raw = json(textValue);
  keys(raw, ['version', 'decisions', 'summary']);
  if (raw.version !== 1 || !Array.isArray(raw.decisions) || raw.decisions.length !== findingIds.length) return fail();
  const remaining = new Set(findingIds);
  const decisions = raw.decisions.map<ReviewDecision>((value) => {
    const decision = object(value);
    keys(decision, ['findingId', 'action', 'reason']);
    const findingId = text(decision.findingId, 80);
    if (!remaining.delete(findingId)) return fail();
    if (decision.action !== 'accept' && decision.action !== 'reject' && decision.action !== 'clarify') return fail();
    return { findingId, action: decision.action, reason: text(decision.reason, 2000) };
  });
  if (remaining.size) return fail();
  return { version: 1, decisions, summary: text(raw.summary, 4000) };
}
