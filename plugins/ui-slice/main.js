definePlugin({
  tools: {
    'slice-image'(input) {
      const { label, imageUrl } = input.parameters ?? {};
      if (typeof label !== 'string' || !label.trim() || label.length > 160
        || typeof imageUrl !== 'string' || imageUrl.length > 240_000
        || !/^(?:https?:\/\/|asset:\/\/localhost\/|data:image\/(?:png|jpeg|webp|gif|avif);base64,).+/iu.test(imageUrl)) {
        throw new Error('请从切图列表选择一个有效的再生候选');
      }
      return { data: { label, imageUrl }, message: '已添加再生候选到画布' };
    },
  },
});
