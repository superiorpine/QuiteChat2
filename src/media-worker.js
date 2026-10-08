import { rasterizeImage, encodeWav } from './media.js';

self.onmessage = async ({ data }) => {
  let result;
  try {
    self.postMessage({ progress: 0.35 });
    if (data.type === 'image') result = await rasterizeImage(data.data, data.info);
    else if (data.type === 'wav') result = encodeWav(data.channels, data.sampleRate);
    else throw new Error('Неизвестная операция с медиа.');
    self.postMessage({ result }, [result.buffer]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Не удалось подготовить приватную копию.' });
  } finally {
    if (data.data?.byteLength) data.data.fill(0);
    data.channels?.forEach((channel) => { if (channel.byteLength) channel.fill(0); });
    if (result?.byteLength) result.fill(0);
  }
};
