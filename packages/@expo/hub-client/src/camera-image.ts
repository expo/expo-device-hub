const CONVERSION_FAILED = 'This browser could not convert the image to PNG.';

/** Convert any browser-decodable image to PNG, which is the only format the emulator's imagefile camera reads. */
export async function toPngBlob(image: Blob): Promise<Blob> {
  if (image.type === 'image/png') return image;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Error('That file could not be read as an image.');
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(CONVERSION_FAILED);
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error(CONVERSION_FAILED);
    return png;
  } finally {
    bitmap.close();
  }
}
