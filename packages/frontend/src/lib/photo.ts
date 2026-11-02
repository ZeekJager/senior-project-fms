// Photos of people and vehicles (docs/photos.md): shrunk and cropped in the browser before upload, so a
// 12-megapixel phone picture is sent as a ~100 KB JPEG and the server never decodes images.

/** What the server accepts (it checks the bytes, not this list); everything else is refused before upload. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp'

/** The original picked from the phone or disk may be large; what is sent is far smaller. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export type PhotoShape = 'portrait' | 'vehicle'

/** People: a 512 px square (shown round). Vehicles: 1280 x 960 (4:3). Both cropped to fill, centred. */
export const PHOTO_SIZE: Record<PhotoShape, { width: number; height: number }> = {
  portrait: { width: 512, height: 512 },
  vehicle: { width: 1280, height: 960 },
}

export class PhotoRejected extends Error {
  constructor(readonly reason: 'type' | 'size' | 'unreadable') {
    super(reason === 'type' ? 'Choose a JPEG, PNG or WebP picture.' : reason === 'size' ? 'That picture is over 25 MB.' : 'That picture could not be read.')
  }
}

/** The centred crop of a `sw` x `sh` image that fills `dw` x `dh` (object-fit: cover). */
export function coverCrop(sw: number, sh: number, dw: number, dh: number): { sx: number; sy: number; sWidth: number; sHeight: number } {
  const scale = Math.max(dw / sw, dh / sh)
  const sWidth = Math.round(dw / scale)
  const sHeight = Math.round(dh / scale)
  return { sx: Math.round((sw - sWidth) / 2), sy: Math.round((sh - sHeight) / 2), sWidth, sHeight }
}

/** The output size: the shape's, or smaller when the original is (a small picture is never blown up). */
export function outputSize(shape: PhotoShape, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const target = PHOTO_SIZE[shape]
  const shrink = Math.min(1, sourceWidth / target.width, sourceHeight / target.height)
  return { width: Math.max(1, Math.round(target.width * shrink)), height: Math.max(1, Math.round(target.height * shrink)) }
}

/** The file as a JPEG of the shape's size, its orientation from EXIF applied. */
export async function preparePhoto(file: File, shape: PhotoShape): Promise<Blob> {
  if (!PHOTO_ACCEPT.split(',').includes(file.type)) throw new PhotoRejected('type')
  if (file.size > MAX_SOURCE_BYTES) throw new PhotoRejected('size')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PhotoRejected('unreadable')
  }
  const { width, height } = outputSize(shape, bitmap.width, bitmap.height)
  const crop = coverCrop(bitmap.width, bitmap.height, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoRejected('unreadable')
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, width, height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86))
  if (!blob) throw new PhotoRejected('unreadable')
  return blob
}

/** The form a photo is sent in: the `file` part, as PUT /…/photo expects. */
export function photoForm(blob: Blob): FormData {
  const form = new FormData()
  form.append('file', blob, 'photo.jpg')
  return form
}
