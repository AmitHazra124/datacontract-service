import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const s3 = new S3Client({});
type ZipArchive = {
  pipe: (stream: NodeJS.WritableStream) => void;
  directory: (path: string, destination: false | string) => void;
  finalize: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};
const archiver = require('archiver') as (format: string, options: { zlib: { level: number } }) => ZipArchive;

type ArtifactRequest = {
  action: 'prepare' | 'package';
  datacontractId: string;
  datacontract: unknown;
  sourceBucket: string;
  sourceKey: string;
  destinationBucket: string;
};

export async function handler(request: ArtifactRequest) {
  if (!request?.action || !request.datacontractId || !request.destinationBucket) {
    throw new Error('action, datacontractId, and destinationBucket are required.');
  }

  const prefix = `integration-adapters/${request.datacontractId}`;
  if (request.action === 'prepare') {
    const folder = `/tmp/${request.datacontractId}`;
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true });

    const source = await s3.send(new GetObjectCommand({ Bucket: request.sourceBucket, Key: request.sourceKey }));
    if (!source.Body) {
      throw new Error('Integration Lambda source object has no body.');
    }
    await pipeline(source.Body as NodeJS.ReadableStream, createWriteStream(join(folder, 'index.js')));
    await fs.writeFile(join(folder, 'datacontract.json'), JSON.stringify(request.datacontract, null, 2));

    for (const fileName of ['index.js', 'datacontract.json']) {
      await s3.send(new PutObjectCommand({
        Bucket: request.destinationBucket,
        Key: `${prefix}/${fileName}`,
        Body: await fs.readFile(join(folder, fileName)),
        ServerSideEncryption: 'AES256',
      }));
    }
    return { ...request, preparedPrefix: prefix };
  }

  const folder = `/tmp/${request.datacontractId}`;
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  for (const fileName of ['index.js', 'datacontract.json']) {
    const object = await s3.send(new GetObjectCommand({
      Bucket: request.destinationBucket,
      Key: `${prefix}/${fileName}`,
    }));
    if (!object.Body) throw new Error(`Missing prepared artifact file: ${fileName}`);
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(join(folder, fileName)));
  }

  const zipPath = `/tmp/${request.datacontractId}.zip`;
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folder, false);
    void archive.finalize();
  });

  const zipKey = `${prefix}/integration-adapter.zip`;
  await s3.send(new PutObjectCommand({
    Bucket: request.destinationBucket,
    Key: zipKey,
    Body: await fs.readFile(zipPath),
    ContentType: 'application/zip',
    ServerSideEncryption: 'AES256',
  }));
  return { ...request, preparedPrefix: prefix, artifactBucket: request.destinationBucket, artifactKey: zipKey };
}