import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { Readable } from 'node:stream';
import { AppError, validationFailed } from '../errors/app-error';

/**
 * Photos of people and vehicles (docs/photos.md): one image per user account or vehicle, in the document
 * storage, its URL versioned by when it changed. Shared by the auth module (users) and fleet (vehicles), each
 * of which keeps the columns on its own table.
 */

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** The browser shrinks a photo before sending it (512 px a side for people, 1280 for vehicles), so 2 MB is plenty. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export type PhotoOwner = 'users' | 'vehicles';

/** A photo's columns on its owner's row: all set, or all null. */
export interface PhotoColumns {
  key: string | null;
  type: PhotoType | null;
  updatedAt: Date | null;
}

/** JPEG, PNG or WebP from the first bytes; the filename and the declared type are the client's claim and ignored. */
export function sniffImage(bytes: Buffer): PhotoType | null {
  const starts = (offset: number, ...sig: number[]) => bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // RIFF....WEBP
  if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** The URL a screen shows the photo from; `v` changes with the photo, so a cached copy is never stale. Null without one. */
export function photoUrl(owner: PhotoOwner, publicId: string, updatedAt: Date | null): string | null {
  return updatedAt ? `/api/v1/${owner}/${publicId}/photo?v=${updatedAt.getTime()}` : null;
}

/** Where a photo lives in the storage: the owner and the time, never anything a client sends. */
export function photoKey(owner: PhotoOwner, publicId: string, at: Date): string {
  return `photos/${owner}/${publicId.toLowerCase()}/${at.getTime()}`;
}

export const photoTooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'A photo may be at most 2 MB.');
export const notAnImage = () => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'A photo must be a JPEG, PNG or WebP image.');
export const noPhoto = () => new AppError(404, 'NOT_FOUND', 'No photo.');

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0, parts: 2 },
}).single('file');

/** Reads the `file` part (2 MB at most) and checks it is an image: `req.photo` is its bytes and type. */
export const receivePhoto: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  multipart(req, res, (err: unknown) => {
    if (err) {
      req.unpipe();
      req.resume();
      if (err instanceof multer.MulterError) {
        return next(err.code === 'LIMIT_FILE_SIZE' ? photoTooLarge() : validationFailed([{ field: err.field ?? 'file', reason: err.code.toLowerCase() }]));
      }
      return next(validationFailed([{ field: 'body', reason: 'malformed_multipart' }], 'The multipart body could not be read.'));
    }
    if (!req.file) return next(validationFailed([{ field: 'file', reason: 'required' }], 'Send the photo as multipart/form-data in the "file" part.'));
    const type = sniffImage(req.file.buffer);
    if (!type) return next(notAnImage());
    res.locals.photo = { bytes: req.file.buffer, type } satisfies UploadedPhoto;
    next();
  });
};

export interface UploadedPhoto {
  bytes: Buffer;
  type: PhotoType;
}

export const uploadedPhoto = (res: Response): UploadedPhoto => res.locals.photo as UploadedPhoto;

/**
 * Sends a photo. Cached privately for a day: its URL changes with the photo. Never sniffed as anything else.
 */
export function sendPhoto(res: Response, photo: { stream: Readable; type: PhotoType }): void {
  res.set({
    'Content-Type': photo.type,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  photo.stream.on('error', (err) => res.destroy(err));
  photo.stream.pipe(res);
}
