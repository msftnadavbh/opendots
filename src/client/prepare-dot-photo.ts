export async function prepareDotPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png'].includes(file.type))
    throw new Error('Choose a JPEG or PNG photo.');
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Choose a photo no larger than 10 MiB.');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read this photo.'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
  } catch {
    throw new Error('Could not decode this photo. Choose a JPEG or PNG.');
  }
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error('This photo has no image dimensions.');
  const scale = Math.min(
    1,
    512 / image.naturalWidth,
    512 / image.naturalHeight,
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context)
    throw new Error('Photo processing is unavailable in this browser.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const encoded = dataUrl.slice('data:image/jpeg;base64,'.length);
  const size =
    (encoded.length / 4) * 3 -
    (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (!dataUrl.startsWith('data:image/jpeg;base64,'))
    throw new Error('JPEG encoding is unavailable in this browser.');
  if (size > 262_144)
    throw new Error('Processed photo exceeds 256 KiB. Choose a simpler photo.');
  return dataUrl;
}
