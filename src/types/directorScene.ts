/** Persisted runtime choice for the single ai-director node type. */
export type DirectorRuntimeKind = 'lightweight-web' | 'blender';

export interface DirectorProjectFileReference {
  kind: 'project-file';
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface DirectorSceneReference {
  schemaVersion: 1;
  sceneId: string;
  revision: number;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface DirectorResultManifestReference {
  schemaVersion: 1;
  sceneId: string;
  sceneRevision: number;
  sceneSha256: string;
  manifestRevision: number;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface DirectorVector3 {
  x: number;
  y: number;
  z: number;
}

export interface DirectorTransform {
  position: DirectorVector3;
  rotationEuler: DirectorVector3;
  scale: DirectorVector3;
}

export interface DirectorSceneParent {
  revision: number;
  sha256: string;
}

export interface DirectorCoordinateSystem {
  handedness: 'right';
  upAxis: 'Z';
  forwardAxis: '-Y';
  lengthUnit: 'meter';
  angleUnit: 'degree';
  rotationOrder: 'XYZ';
}

export interface DirectorTimeline {
  fps: number;
  startFrame: number;
  endFrame: number;
}

export interface DirectorWorldColor {
  r: number;
  g: number;
  b: number;
}

export interface DirectorEnvironment {
  worldColor: DirectorWorldColor;
  asset?: DirectorProjectFileReference;
}

export interface DirectorSceneEntity {
  entityId: string;
  kind: 'character' | 'prop';
  name: string;
  asset: DirectorProjectFileReference;
  transform: DirectorTransform;
  visible: boolean;
}

export type DirectorCameraInterpolation = 'constant' | 'linear' | 'bezier';

export interface DirectorCameraKeyframe {
  frame: number;
  interpolation: DirectorCameraInterpolation;
  transform: DirectorTransform;
  focalLengthMm?: number;
  apertureFStop?: number;
  focusDistanceM?: number;
}

export interface DirectorCamera {
  cameraId: string;
  name: string;
  transform: DirectorTransform;
  focalLengthMm: number;
  sensorWidthMm: number;
  apertureFStop: number;
  focusDistanceM: number;
  keyframes: DirectorCameraKeyframe[];
}

export interface DirectorShot {
  shotId: string;
  name: string;
  startFrame: number;
  endFrame: number;
  cameraId: string;
}

export interface DirectorScene {
  schemaVersion: 1;
  sceneId: string;
  revision: number;
  parent: DirectorSceneParent | null;
  coordinateSystem: DirectorCoordinateSystem;
  timeline: DirectorTimeline;
  environment: DirectorEnvironment;
  entities: DirectorSceneEntity[];
  cameras: DirectorCamera[];
  shots: DirectorShot[];
}

interface DirectorResultArtifactBase {
  artifactId: string;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface DirectorFrameImageArtifact extends DirectorResultArtifactBase {
  kind: 'frame-image';
  mimeType: 'image/png';
  frame: number;
}

export interface DirectorReferenceVideoArtifact extends DirectorResultArtifactBase {
  kind: 'reference-video';
  mimeType: 'video/mp4';
  startFrame: number;
  endFrame: number;
  fps: number;
}

export interface DirectorBlendProjectArtifact extends DirectorResultArtifactBase {
  kind: 'blend-project';
  mimeType: 'application/x-blender';
}

export type DirectorResultArtifact =
  | DirectorFrameImageArtifact
  | DirectorReferenceVideoArtifact
  | DirectorBlendProjectArtifact;

export type DirectorResultProducer =
  | {
      runtime: 'lightweight-web';
      adapterVersion: string;
    }
  | {
      runtime: 'blender';
      adapterVersion: string;
      blenderVersion: string;
    };

export interface DirectorResultManifest {
  schemaVersion: 1;
  sceneId: string;
  sceneRevision: number;
  sceneSha256: string;
  manifestRevision: number;
  producer: DirectorResultProducer;
  artifacts: DirectorResultArtifact[];
}
