import { generateId } from '../../store/useAppStore';
import type { CharacterReferenceKind, CharacterVoiceKind, DramaCharacter } from '../../types/dramaAssets';
import { CHARACTER_REFERENCE_KIND_LABELS, CHARACTER_VOICE_KIND_LABELS } from './characterReferencePresentation';

export type CharacterLibraryScope = 'project' | 'global';

export const REFERENCE_KINDS = Object.entries(CHARACTER_REFERENCE_KIND_LABELS) as Array<[
  CharacterReferenceKind,
  string,
]>;

export const VOICE_KINDS = Object.entries(CHARACTER_VOICE_KIND_LABELS) as Array<[
  CharacterVoiceKind,
  string,
]>;

export function createEmptyCharacter(): DramaCharacter {
  const now = Date.now();
  return {
    id: `character-${generateId()}`,
    kind: 'character',
    name: '',
    key: '',
    identity: '',
    summary: '',
    visualNotes: '',
    importance: 'supporting',
    confirmed: true,
    createdAt: now,
    updatedAt: now,
    source: 'manual',
    referenceImages: [],
    voiceClips: [],
  };
}
