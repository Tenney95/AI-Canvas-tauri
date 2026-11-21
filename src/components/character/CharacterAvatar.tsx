import { Icon } from '@iconify/react';
import type { CharacterReferenceImage, DramaCharacter } from '../../types/dramaAssets';
import ViewportImage from '../shared/ViewportImage';
import { cropImageStyle } from './characterReferencePresentation';

function characterAvatar(character: DramaCharacter): CharacterReferenceImage | undefined {
  const references = character.referenceImages ?? [];
  return references.find((reference) => reference.id === character.avatarReferenceImageId)
    ?? references.find((reference) => reference.id === character.primaryReferenceImageId)
    ?? references[0];
}

export default function CharacterAvatar({ character }: { character: DramaCharacter }) {
  const reference = characterAvatar(character);
  const cropped = reference?.id === character.avatarReferenceImageId && character.avatarCrop;
  return (
    <span className="character-avatar">
      {reference?.imageUrl ? (
        <ViewportImage
          src={reference.imageUrl}
          alt=""
          draggable={false}
          className={cropped ? 'is-cropped' : ''}
          style={cropped ? cropImageStyle(character.avatarCrop) : undefined}
        />
      ) : (
        <Icon icon="lucide:user-round" width={22} height={22} aria-hidden="true" />
      )}
    </span>
  );
}
