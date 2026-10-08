/** Downscale big photos before upload (max 1600px, JPEG 85%). GIFs and small files pass through. */
export async function shrinkImage(file: File): Promise<{ blob: Blob; name: string }> {
  if (file.type === 'image/gif' || file.size < 350_000) return { blob: file, name: file.name || 'photo.jpg' };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return blob && blob.size < file.size ? { blob, name: `${base}.jpg` } : { blob: file, name: file.name };
  } catch {
    return { blob: file, name: file.name };
  }
}

/** Pasted screenshots have no name; give them one with the right extension. */
export function fileNameFor(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
  return `${file.type.startsWith('image/') ? 'photo' : 'file'}-${Date.now()}.${ext}`;
}
