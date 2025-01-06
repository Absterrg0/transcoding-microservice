"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const mongodb_1 = require("mongodb");
const client_s3_1 = require("@aws-sdk/client-s3");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const storage = multer_1.default.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const uniqueSuffix = new mongodb_1.ObjectId().toHexString();
        cb(null, uniqueSuffix + path_1.default.extname(file.originalname));
    }
});
const upload = (0, multer_1.default)({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }
});
app.use((0, cors_1.default)());
app.use(express_1.default.json());
['uploads', 'hls'].forEach(dir => {
    if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
});
const s3Client = new client_s3_1.S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});
function getVideoDuration(inputPath) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            const ffprobe = (0, child_process_1.spawn)('ffmpeg', ['-i', inputPath, '-hide_banner']);
            ffprobe.stderr.on('data', (data) => {
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
            ffprobe.on('error', (err) => reject(err));
        });
    });
}
app.post('/transcode-and-upload', upload.single('file'), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (!req.file) {
        res.status(400).json({ success: false, error: 'No file uploaded' });
        return;
    }
    const mongoId = new mongodb_1.ObjectId().toHexString();
    const hlsBasePath = path_1.default.join(process.cwd(), 'hls');
    const hlsFolderPath = path_1.default.join(hlsBasePath, mongoId);
    const uploadsFolderPath = path_1.default.join(process.cwd(), 'uploads');
    const inputPath = path_1.default.join(uploadsFolderPath, req.file.filename);
    try {
        const duration = yield getVideoDuration(inputPath);
        console.log(duration);
        fs_1.default.mkdirSync(hlsFolderPath, { recursive: true });
        const playlistPath = path_1.default.join(hlsFolderPath, 'playlist.m3u8');
        const segmentPattern = path_1.default.join(hlsFolderPath, 'segment%03d.ts');
        console.log('Input file path:', inputPath);
        console.log('Output folder:', hlsFolderPath);
        const ffmpeg = (0, child_process_1.spawn)('ffmpeg', [
            '-i', inputPath,
            '-vf', `scale=${process.env.FFMPEG_RATIO || '720:-1'}`,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-g', '30',
            '-sc_threshold', '0',
            '-hls_time', '10',
            '-hls_list_size', '0',
            '-hls_segment_type', 'mpegts',
            '-hls_flags', 'independent_segments',
            '-f', 'hls',
            '-max_muxing_queue_size', '1024',
            '-hls_segment_filename', segmentPattern,
            playlistPath
        ]);
        ffmpeg.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data.toString()}`);
        });
        ffmpeg.on('close', (code) => __awaiter(void 0, void 0, void 0, function* () {
            if (code !== 0) {
                if (fs_1.default.existsSync(hlsFolderPath)) {
                    fs_1.default.rmSync(hlsFolderPath, { recursive: true, force: true });
                }
                res.status(500).json({ success: false, error: 'Failed to convert video to HLS' });
                return;
            }
            try {
                const segmentUrls = yield uploadSegmentsToS3(hlsFolderPath, mongoId);
                yield updateAndUploadPlaylist(playlistPath, segmentUrls, mongoId);
                const playlistUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/hls/${mongoId}/playlist.m3u8`;
                if (fs_1.default.existsSync(inputPath)) {
                    fs_1.default.unlinkSync(inputPath);
                }
                if (fs_1.default.existsSync(hlsFolderPath)) {
                    fs_1.default.rmSync(hlsFolderPath, { recursive: true, force: true });
                }
                res.json({
                    success: true,
                    mongoId,
                    playlistUrl,
                    videoDuration: duration
                });
            }
            catch (err) {
                console.error('Error processing and uploading:', err);
                res.status(500).json({ success: false, error: 'Failed to process and upload files' });
            }
        }));
        ffmpeg.on('error', (err) => {
            console.error('FFmpeg spawn error:', err);
            if (fs_1.default.existsSync(hlsFolderPath)) {
                fs_1.default.rmSync(hlsFolderPath, { recursive: true, force: true });
            }
            res.status(500).json({ success: false, error: 'Error spawning FFmpeg process' });
        });
    }
    catch (err) {
        console.error('Error getting video duration:', err);
        res.status(500).json({ success: false, error: 'Failed to get video duration' });
    }
}));
function uploadSegmentsToS3(folderPath, mongoId) {
    return __awaiter(this, void 0, void 0, function* () {
        const files = fs_1.default.readdirSync(folderPath).filter(file => file.endsWith('.ts'));
        const uploadedUrls = [];
        for (const file of files) {
            const filePath = path_1.default.join(folderPath, file);
            const fileContent = fs_1.default.readFileSync(filePath);
            const s3Key = `hls/${mongoId}/${file}`;
            const command = new client_s3_1.PutObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: s3Key,
                Body: fileContent,
                ContentType: 'video/MP2T'
            });
            yield s3Client.send(command);
            uploadedUrls.push(`https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`);
        }
        return uploadedUrls;
    });
}
function updateAndUploadPlaylist(playlistPath, segmentUrls, mongoId) {
    return __awaiter(this, void 0, void 0, function* () {
        let playlistContent = fs_1.default.readFileSync(playlistPath, 'utf8');
        segmentUrls.forEach((url, index) => {
            const segmentFilename = `segment${index.toString().padStart(3, '0')}.ts`;
            playlistContent = playlistContent.replace(segmentFilename, url);
        });
        const s3Key = `hls/${mongoId}/playlist.m3u8`;
        const command = new client_s3_1.PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
            Body: playlistContent,
            ContentType: 'application/vnd.apple.mpegurl'
        });
        yield s3Client.send(command);
    });
}
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
