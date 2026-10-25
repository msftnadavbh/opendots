import sharp from 'sharp';
import { z } from 'zod';

const maxBytes = 262_144;
const prefix = 'data:image/jpeg;base64,';
const schema = z.object({ dataUrl: z.string() }).strict();

export class PhotoValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

export async function validateDotPhoto(body: unknown): Promise<Buffer> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new PhotoValidationError('Provide only a JPEG dataUrl.');
  const { dataUrl } = parsed.data;
  if (dataUrl.length > prefix.length + 4 * Math.ceil(maxBytes / 3))
    throw new PhotoValidationError('Photo exceeds 256 KiB.', 413);
  if (!dataUrl.startsWith(prefix))
    throw new PhotoValidationError('Provide a JPEG data URL.');
  const encoded = dataUrl.slice(prefix.length);
  if (
    !encoded.length ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new PhotoValidationError('Invalid JPEG base64.');
  const length =
    (encoded.length / 4) * 3 -
    (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (length > maxBytes)
    throw new PhotoValidationError('Photo exceeds 256 KiB.', 413);
  const input = Buffer.from(encoded, 'base64');
  if (
    input.toString('base64') !== encoded ||
    input[0] !== 0xff ||
    input[1] !== 0xd8 ||
    input[2] !== 0xff
  )
    throw new PhotoValidationError('Invalid JPEG image.');
  let output: Buffer;
  try {
    const image = sharp(input, {
      limitInputPixels: 262_144,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== 'jpeg' ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 512 ||
      metadata.height > 512
    )
      throw new Error('Invalid JPEG dimensions.');
    // metadata() only reads headers; re-encoding validates pixels and strips metadata.
    output = await image.autoOrient().jpeg({ quality: 85 }).toBuffer();
  } catch {
    throw new PhotoValidationError(
      'Use a complete JPEG image up to 512 × 512.',
    );
  }
  if (output.length > maxBytes)
    throw new PhotoValidationError('Photo exceeds 256 KiB.', 413);
  return output;
}
