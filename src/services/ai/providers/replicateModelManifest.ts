/** Official Replicate models share the Prediction lifecycle. Model entries declare only input and output shape. */
import type { ProviderModelSelection } from '../../../types';
import type { ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, ResolvedModelProtocolPoll } from '../../../types/aiTypes';

export const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';
const REPLICATE_FAILURE_STATUSES = ['failed', 'canceled', 'aborted'] as const;
const replicatePredictionStatuses: ReadonlySet<string> = new Set([
  'starting', 'processing', 'succeeded', ...REPLICATE_FAILURE_STATUSES,
]);

export function isReplicatePredictionStatus(value: unknown): value is string {
  return typeof value === 'string' && replicatePredictionStatuses.has(value);
}

export function replicatePredictionIdFromPoll(poll: ResolvedModelProtocolPoll): string | undefined {
  if (poll.method !== 'GET' || poll.auth?.type !== 'bearer' || poll.statusPath !== 'status'
    || (poll.resultUrlPath !== 'output' && poll.resultUrlPath !== 'output.*')) return undefined;
  const url = new URL(poll.url);
  if (url.origin !== 'https://api.replicate.com' || url.search || url.hash) return undefined;
  return /^\/v1\/predictions\/([a-z0-9_-]+)$/i.exec(url.pathname)?.[1];
}

const RATIOS = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21'];

export function replicatePredictionProtocolV1(
  slug: string,
  input: Record<string, ProtocolJsonValue>,
  outputPath: 'output' | 'output.*',
): NormalizedModelExecutionProtocol {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/.test(slug)) throw new Error('Replicate 官方模型 ID 无效');
  return {
    version: 2,
    mode: 'async',
    auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/models/' + slug + '/predictions', bodyEncoding: 'json', body: { input } },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'detail' },
    poll: {
      method: 'GET', path: '/predictions/{{submit.id}}',
      response: { statusPath: 'status', successValues: ['succeeded'], failureValues: [...REPLICATE_FAILURE_STATUSES],
        errorPath: 'error', result: { urlPath: outputPath } },
      intervalMs: 3_000, maxDurationMs: 3_600_000,
      retry: { maxRetries: 5, backoff: 'exponential', maxDelayMs: 30_000, honorRetryAfter: true, retryNetworkErrors: true },
    },
  };
}

function profile(slug: string, input: Record<string, ProtocolJsonValue>, outputPath: 'output' | 'output.*'): ModelExecutionProfile {
  return { preset: 'custom', protocol: replicatePredictionProtocolV1(slug, input, outputPath) };
}

export const REPLICATE_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...['flux-schnell', 'flux-dev'].map((id): ProviderModelSelection => {
    const slug = 'black-forest-labs/' + id;
    return {
      id: slug, name: id === 'flux-dev' ? 'FLUX.1 Dev' : 'FLUX.1 Schnell',
      provider: 'replicate', category: 'image', inputModalities: ['text'],
      imageCapability: { ratios: [...RATIOS], defaultRatio: '1:1', supportsBatch: true, maxBatchCount: 4,
        supportsImageReference: false, maxImageReferences: 0 },
      executionProfile: profile(slug, { prompt: '{{prompt}}', aspect_ratio: '{{aspectRatio}}', num_outputs: '{{n}}' }, 'output.*'),
    };
  }),
  ...['veo-3.1', 'veo-3.1-fast'].map((id): ProviderModelSelection => {
    const slug = 'google/' + id;
    return {
      id: slug, name: id.endsWith('-fast') ? 'Veo 3.1 Fast · 文生视频' : 'Veo 3.1 · 文生视频',
      provider: 'replicate', category: 'video', inputModalities: ['text'],
      videoCapability: { operations: ['text-to-video'], ratios: ['16:9', '9:16'], defaultRatio: '16:9',
        durations: [4, 6, 8], defaultDuration: 8, resolutions: ['720p', '1080p'], defaultResolution: '1080p',
        maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0,
        supportsAudio: true, inputConstraints: { promptMinCharacters: 1 } },
      executionProfile: profile(slug, { prompt: '{{prompt}}', aspect_ratio: '{{aspectRatio}}', duration: '{{duration}}',
        resolution: '{{resolution}}', generate_audio: '{{generateAudio}}' }, 'output'),
    };
  }),
];
