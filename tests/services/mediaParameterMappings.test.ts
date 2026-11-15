/**
 * mediaParameterMappings — 回归测试：media parameter mappings。
 */
import { describe, expect, it } from 'vitest';
import { buildAudioMusicRequestBody, buildAudioSpeechRequestBody, mapAudioParameters } from '../../src/services/ai/audioParameterMappings';
import { buildStandardImageRequestBody, mapImageParameters } from '../../src/services/ai/imageParameterMappings';
import { mapVideoParameters } from '../../src/services/ai/videoParameterMappings';

describe('media parameter mappings', () => {
  it('requests PNG for transparent output and otherwise keeps background and format absent', () => {
    const input = { modelName: 'gpt-image-2.5-sunburst', prompt: 'sticker', count: 1, size: '2048x1152' };
    expect(buildStandardImageRequestBody({ ...input, imageBackground: 'transparent' })).toMatchObject({
      size: '2048x1152', background: 'transparent', output_format: 'png',
    });
    for (const imageBackground of [undefined, '']) {
      const body = buildStandardImageRequestBody({ ...input, imageBackground });
      expect(body).not.toHaveProperty('background');
      expect(body).not.toHaveProperty('output_format');
    }
    expect(buildStandardImageRequestBody({ ...input, imageBackground: 'opaque' }))
      .not.toHaveProperty('output_format');
    expect(mapImageParameters('apimart', input.modelName, { imageBackground: 'transparent' }))
      .toEqual({ background: 'transparent' });
  });
  it('keeps image quality separate from resolution and omits undeclared quality', () => {
    const input = { modelName: 'gpt-image-2.5-sunburst', prompt: 'cat', count: 1, size: '2048x1152' };
    expect(buildStandardImageRequestBody({ ...input, imageQuality: 'max' })).toMatchObject({
      size: '2048x1152', quality: 'max',
    });
    expect(buildStandardImageRequestBody(input)).not.toHaveProperty('quality');
    expect(mapImageParameters('apimart', input.modelName, { imageSize: '2K', imageQuality: 'low' }))
      .toEqual({ resolution: '2K', quality: 'low' });
  });
  it('maps standard image UI fields to OpenAI-compatible fields', () => {
    expect(buildStandardImageRequestBody({
      modelName: 'flux-2-pro',
      prompt: 'cat',
      count: 2,
      size: '1024x1024',
      imageUrls: ['https://example.com/ref.png'],
    })).toEqual({
      model: 'flux-2-pro',
      prompt: 'cat',
      n: 2,
      size: '1024x1024',
      response_format: 'url',
      image_urls: ['https://example.com/ref.png'],
    });
  });

  it('maps provider-specific image field names', () => {
    expect(mapImageParameters('volcengine', 'doubao-seedream-5-0-pro-260628', {
      model: 'doubao-seedream-5-0-pro-260628',
      prompt: 'cat',
      imageSize: '2K',
      referenceImageUrls: ['https://example.com/ref.png'],
    })).toMatchObject({
      size: '2K',
      image: ['https://example.com/ref.png'],
      watermark: true,
    });
  });

  it('maps video references without exposing provider fields to the caller', () => {
    expect(mapVideoParameters('apimart', 'apimart/seedance', {
      resolution: '720p',
      aspectRatio: '16:9',
      duration: 5,
      generateAudio: true,
      imageUrls: ['https://example.com/ref.png'],
    })).toMatchObject({
      resolution: '720p',
      aspect_ratio: '16:9',
      duration: 5,
      generate_audio: true,
      image_urls: ['https://example.com/ref.png'],
    });
  });

  it('maps APIMart TTS and Flow Music fields', () => {
    expect(buildAudioSpeechRequestBody({ model: 'tts-1', input: 'hello', voice: 'alloy', format: 'wav', speed: 1 })).toEqual({
      model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'wav', speed: 1,
    });
    expect(buildAudioMusicRequestBody({ soundPrompt: 'jazz', musicLyrics: 'la', musicTitle: 'demo', musicBpm: 120, musicDuration: 30 })).toEqual({
      model: 'flowmusic', sound_prompt: 'jazz', lyrics: 'la', title: 'demo', bpm: '120', length: 30,
    });
  });

  it('omits undefined fields instead of sending empty provider parameters', () => {
    expect(mapAudioParameters('standard', 'tts', { model: 'tts', input: 'hello', voice: undefined })).toEqual({ model: 'tts', input: 'hello' });
  });

  it('keeps zero and false while omitting empty fields for all media types', () => {
    expect(mapImageParameters('apimart', 'image', {
      batchCount: 0, prompt: '', imageSize: null, imageQuality: undefined, referenceImageUrls: [],
    })).toEqual({ n: 0 });
    expect(mapAudioParameters('standard', 'tts', {
      model: 'tts', input: '', voice: null, format: undefined, speed: 0,
    })).toEqual({ model: 'tts', speed: 0 });
    expect(mapVideoParameters('standard', 'video', {
      duration: 0, generateAudio: false, prompt: '', resolution: null, aspectRatio: undefined, imageUrls: [],
    })).toEqual({ duration: 0, generate_audio: false });
  });

  it('overrides static defaults without changing them and preserves reference arrays', () => {
    expect(mapAudioParameters('apimart', 'flowmusic', { model: 'custom' })).toEqual({ model: 'custom' });
    expect(mapAudioParameters('apimart', 'flowmusic', { model: '' })).toEqual({ model: 'flowmusic' });
    expect(mapAudioParameters('apimart', 'flowmusic', {})).toEqual({ model: 'flowmusic' });
    const imageUrls = ['https://example.com/ref.png'];
    expect(mapImageParameters('apimart', 'image', { referenceImageUrls: imageUrls }).image_urls).toBe(imageUrls);
    expect(imageUrls).toEqual(['https://example.com/ref.png']);
  });
});
