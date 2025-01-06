import express, { Request, Response } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ObjectId } from 'mongodb';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueSuffix = new ObjectId().toHexString();
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize:5 * 1024 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

['uploads', 'hls'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

async function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffmpeg', ['-i', inputPath, '-hide_banner']);

    ffprobe.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        const [, hours, minutes, seconds] = durationMatch.map(Number);
        const duration = hours * 3600 + minutes * 60 + seconds;
        resolve(duration);
      }
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Failed to get video duration'));
      }
    });

    ffprobe.on('error', (err: Error) => reject(err));
  });
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Service is up and running',
    timestamp: new Date().toISOString(),
  });
});


app.post('/transcode-and-upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'No file uploaded' });
    return;
  }

  const mongoId = new ObjectId().toHexString();
  const hlsBasePath = path.join(process.cwd(), 'hls');
  const hlsFolderPath = path.join(hlsBasePath, mongoId);
  const uploadsFolderPath = path.join(process.cwd(), 'uploads');
  const inputPath = path.join(uploadsFolderPath, req.file.filename);

  try {
    const duration = await getVideoDuration(inputPath);
    console.log(duration)
    fs.mkdirSync(hlsFolderPath, { recursive: true });

    const playlistPath = path.join(hlsFolderPath, 'playlist.m3u8');
    const segmentPattern = path.join(hlsFolderPath, 'segment%03d.ts');

    console.log('Input file path:', inputPath);
    console.log('Output folder:', hlsFolderPath);

const ffmpeg = spawn('ffmpeg', [
  '-i', inputPath,
  '-vf', `scale=${process.env.FFMPEG_RATIO || '720:-1'}`,      // Scale to 480p for lower resolution
  '-c:v', 'libx264',          // Use H.264 codec
  '-preset', 'ultrafast',     // Ultra-fast preset for speed
  '-threads', '1',            // Limit to 1 thread due to CPU constraints
  '-b:v', '500k',             // Lower bitrate (500kbps)
  '-g', '30',                 // GOP size
  '-sc_threshold', '0',       // Disable scene change detection
  '-hls_time', '20',          // Segment duration (20 seconds)
  '-hls_list_size', '0',      // No limit on the playlist size
  '-hls_segment_type', 'mpegts',
  '-hls_flags', 'independent_segments',
  '-f', 'hls',
  '-max_muxing_queue_size', '1024',  // Keep it low for limited memory
  '-hls_segment_filename', segmentPattern,
  playlistPath
]);


    ffmpeg.stderr.on('data', (data: Buffer) => {
      console.error(`FFmpeg stderr: ${data.toString()}`);
    });

    ffmpeg.on('close', async (code: number) => {
      if (code !== 0) {
        if (fs.existsSync(hlsFolderPath)) {
          fs.rmSync(hlsFolderPath, { recursive: true, force: true });
        }
        res.status(500).json({ success: false, error: 'Failed to convert video to HLS' });
        return;
      }

      try {
        const segmentUrls = await uploadSegmentsToS3(hlsFolderPath, mongoId);
        await updateAndUploadPlaylist(playlistPath, segmentUrls, mongoId);

        const playlistUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/hls/${mongoId}/playlist.m3u8`;

        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }

        if (fs.existsSync(hlsFolderPath)) {
          fs.rmSync(hlsFolderPath, { recursive: true, force: true });
        }

        res.json({
          success: true,
          mongoId,
          playlistUrl,
          videoDuration:duration
        });
      } catch (err) {
        console.error('Error processing and uploading:', err);
        res.status(500).json({ success: false, error: 'Failed to process and upload files' });
      }
    });

    ffmpeg.on('error', (err: Error) => {
      console.error('FFmpeg spawn error:', err);
      if (fs.existsSync(hlsFolderPath)) {
        fs.rmSync(hlsFolderPath, { recursive: true, force: true });
      }
      res.status(500).json({ success: false, error: 'Error spawning FFmpeg process' });
    });
  } catch (err) {
    console.error('Error getting video duration:', err);
    res.status(500).json({ success: false, error: 'Failed to get video duration' });
  }
});

async function uploadSegmentsToS3(folderPath: string, mongoId: string): Promise<string[]> {
  const files = fs.readdirSync(folderPath).filter(file => file.endsWith('.ts'));
  const uploadedUrls: string[] = [];

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const fileContent = fs.readFileSync(filePath);
    const s3Key = `hls/${mongoId}/${file}`;

    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME!,
      Key: s3Key,
      Body: fileContent,
      ContentType: 'video/MP2T'
    });

    await s3Client.send(command);
    uploadedUrls.push(`https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`);
  }

  return uploadedUrls;
}

async function updateAndUploadPlaylist(playlistPath: string, segmentUrls: string[], mongoId: string): Promise<void> {
  let playlistContent = fs.readFileSync(playlistPath, 'utf8');

  segmentUrls.forEach((url, index) => {
    const segmentFilename = `segment${index.toString().padStart(3, '0')}.ts`;
    playlistContent = playlistContent.replace(segmentFilename, url);
  });

  const s3Key = `hls/${mongoId}/playlist.m3u8`;
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME!,
    Key: s3Key,
    Body: playlistContent,
    ContentType: 'application/vnd.apple.mpegurl'
  });

  await s3Client.send(command);
}

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
