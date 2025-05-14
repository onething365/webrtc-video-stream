const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const {
  RTCPeerConnection,
  MediaStream,
  RTCSessionDescription,
  nonstandard: { RTCVideoSource },
} = require('wrtc');

const app = express();
const port = 3000;

const config = {
  videoDir: path.join(__dirname, 'videos'),
  videoFile: 'test.mp4',
  videoWidth: 640,
  videoHeight: 480,
  videoFps: 30,
};

// 创建视频目录（如果不存在）
if (!fs.existsSync(config.videoDir)) {
  fs.mkdirSync(config.videoDir);
  console.log(`[SERVER] 创建视频目录: ${config.videoDir}`);
}

app.use(express.json());
app.use(express.static('public')); // 前端静态文件

app.post('/webrtc-offer', async (req, res) => {
  console.log('[SERVER] 收到 WebRTC offer');
  const pc = new RTCPeerConnection();
  const videoSource = new RTCVideoSource();
  const videoTrack = videoSource.createTrack();
  const stream = new MediaStream([videoTrack]);

  // 添加轨道
  pc.addTrack(videoTrack, stream);

  const transceiver = pc.addTransceiver('video', { direction: 'sendonly' });
  transceiver.sender.replaceTrack(videoTrack);

  // 清理资源
  pc.oniceconnectionstatechange = () => {
    // 监听连接状态的变化
    console.log('[SERVER] ICE 状态:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected') {
      console.log('[SERVER] 连接断开，停止轨道');
      videoTrack.stop();
      pc.close();
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(req.body));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    res.json({ type: 'answer', sdp: pc.localDescription.sdp });
  } catch (err) {
    console.error('[SERVER] SDP 处理失败:', err);
    res.status(500).send(err.message);
    return;
  }

  const videoPath = path.join(config.videoDir, config.videoFile);
  if (!fs.existsSync(videoPath)) {
    console.error('[SERVER] 视频不存在:', videoPath);
    return;
  }

  // 视频帧推送
  const frameSize = config.videoWidth * config.videoHeight * 1.5;
  let buffer = Buffer.alloc(0);
  let frameCount = 0;

  const ffmpegProcess = ffmpeg(videoPath)
    .inputOptions(['-re'])
    .videoCodec('rawvideo')
    .outputOptions([
      '-f rawvideo',
      '-pix_fmt yuv420p',
      `-s ${config.videoWidth}x${config.videoHeight}`,
      `-r ${config.videoFps}`,
      '-an',
    ])
    .on('start', (cmd) => console.log('[FFmpeg 启动]', cmd))
    .on('stderr', (line) => console.log('[FFmpeg]', line))
    .on('error', (err) => {
      console.error('[SERVER] FFmpeg 错误:', err.message);
      videoTrack.stop();
      pc.close();
    })
    .on('end', () => {
      console.log('[SERVER] 视频播放结束');
      videoTrack.stop();
      pc.close();
    });

  ffmpegProcess.pipe().on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= frameSize) {
      const frame = buffer.subarray(0, frameSize);
      buffer = buffer.subarray(frameSize);
      try {
        videoSource.onFrame({
          width: config.videoWidth,
          height: config.videoHeight,
          data: new Uint8Array(frame),
          format: 'I420',
        });
        frameCount++;
        if (frameCount % 100 === 0) {
          console.log(`[SERVER] 已发送帧数: ${frameCount}`);
        }
      } catch (err) {
        console.error('[SERVER] 推送帧失败:', err);
      }
    }
  });
});

app.listen(port, () => {
  console.log(`[SERVER] 服务启动: http://localhost:${port}`);
  console.log(`[SERVER] 请将视频文件放入: ${config.videoDir}/${config.videoFile}`);
});
