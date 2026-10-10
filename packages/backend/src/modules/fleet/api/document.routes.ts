import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { publicRoute } from '../../../shared/authz/route-policy';
import { validationFailed } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DocumentService } from '../application/document.service';
import { DOCUMENT_OWNER_TYPES, DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, documentNotFound, fileTooLarge } from '../domain/document';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = z.iso.date();

/** The form fields of POST /documents (the file is the `file` part). */
const uploadFields = z.strictObject({
  owner_type: z.enum(DOCUMENT_OWNER_TYPES),
  owner_id: z.uuid(),
  document_type: z.enum(DOCUMENT_TYPES),
  expires_on: date.optional(),
  retain_until: date.optional(),
});

/** Most owners one GET /documents names: a page of the vehicle or driver list. */
const MAX_LIST_OWNERS = 100;

/** GET /documents: one owner type, and up to 100 owner ids separated by commas. */
const listQuery = z.object({
  owner_type: z.enum(DOCUMENT_OWNER_TYPES),
  owner_id: z
    .string()
    .transform((s) => s.split(',').map((id) => id.trim()))
    .pipe(z.array(z.uuid()).min(1).max(MAX_LIST_OWNERS)),
});

const contentQuery = z.object({ expires: z.string().optional(), signature: z.string().optional() });

// Streams the multipart body and stops reading as soon as the file passes
// 10 MB. Held in memory (10 MB at most) to sniff, hash and store it.
const multipart = multer({
  storage: multer.memoryStorage(),
  // Filenames are UTF-8 (the parser's default is Latin-1, which garbles "é").
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
}).single('file');

/** Runs multer and turns its errors into the contract's (413 for size, 400 otherwise). */
const receiveFile: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  multipart(req, res, (err: unknown) => {
    if (!err) return next();
    // Drain what the client is still sending, so the error response reaches it.
    req.unpipe();
    req.resume();
    if (err instanceof multer.MulterError) {
      return next(err.code === 'LIMIT_FILE_SIZE' ? fileTooLarge() : validationFailed([{ field: err.field ?? 'file', reason: err.code.toLowerCase() }]));
    }
    // Anything else the parser rejects is a broken request, not a server fault.
    next(validationFailed([{ field: 'body', reason: 'malformed_multipart' }], 'The multipart body could not be read.'));
  });
};

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function documentId(req: Request): string {
  const id = req.params.documentId;
  if (!UUID.test(id)) throw documentNotFound();
  return id;
}

/** `inline` with the original name, RFC 5987-encoded so any character is safe. */
function contentDisposition(filename: string | null): string {
  if (!filename) return 'inline';
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Documents (api-contract §8): upload, read with a signed link, fetch the bytes, delete. */
export function documentRouter(service: DocumentService): Router {
  const router = Router();

  router.post(
    '/documents',
    authorize('document:write'),
    receiveFile,
    asyncHandler(async (req, res) => {
      if (!req.file) throw validationFailed([{ field: 'file', reason: 'required' }], 'Send the file as multipart/form-data in the "file" part.');
      const fields = parseInput(uploadFields, req.body);
      const document = await service.upload(caller(req), { ...fields, file: { bytes: req.file.buffer, originalName: req.file.originalname } });
      res.status(201).location(`/api/v1/documents/${document.id}`).json({ data: document, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/documents',
    authorize('document:read'),
    asyncHandler(async (req, res) => {
      const { owner_type, owner_id } = parseInput(listQuery, req.query);
      res.json({ data: await service.list(caller(req), owner_type, owner_id), meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/documents/:documentId',
    authorize('document:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(caller(req), documentId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  // The signed link from GET /documents/{id}. Public: the signature is the
  // permission. Served with nosniff so a browser never runs the bytes as anything else.
  router.get(
    '/documents/:documentId/content',
    publicRoute(),
    asyncHandler(async (req, res) => {
      const { expires, signature } = parseInput(contentQuery, req.query);
      const file = await service.content(documentId(req), expires, signature);
      res.set({
        'Content-Type': file.contentType,
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': contentDisposition(file.filename),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      file.stream.on('error', (err) => res.destroy(err));
      file.stream.pipe(res);
    }),
  );

  router.delete(
    '/documents/:documentId',
    authorize('document:delete'),
    asyncHandler(async (req, res) => {
      await service.remove(caller(req), documentId(req));
      res.status(204).end();
    }),
  );

  return router;
}
