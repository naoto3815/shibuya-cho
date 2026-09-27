// Explicit local review tool. It records the actual game canvas; never runs in ordinary play.
export function attachArrivalCapture(engine, review, play) {
  const button = document.createElement('button');
  button.textContent = '変更後の演出を録画';
  button.style.cssText = 'padding:12px 20px;margin:8px';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  review.append(button, status);
  button.onclick = () => {
    const canvas = document.getElementById('game');
    const mimeType = ['video/mp4;codecs=avc1.42001E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(type => window.MediaRecorder?.isTypeSupported(type));
    if (!mimeType || !canvas.captureStream) { status.textContent = 'このブラウザーでは録画に対応していません。'; return; }
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 5000000});
    const chunks = [];
    recorder.ondataavailable = event => { if(event.data.size)chunks.push(event.data); };
    recorder.onerror = () => { stream.getTracks().forEach(t=>t.stop()); review.hidden=false; button.disabled=false; status.textContent='録画に失敗しました。'; };
    recorder.onstop = () => {
      stream.getTracks().forEach(t=>t.stop());
      const blob = new Blob(chunks, {type:mimeType});
      const link = document.createElement('a');
      link.href=URL.createObjectURL(blob);
      link.download=`shibuya-arrival-review-v3.${mimeType.startsWith('video/mp4')?'mp4':'webm'}`;
      link.textContent='確認動画を保存'; link.style.cssText='color:#e5c880;padding:16px;display:inline-block';
      status.replaceChildren(link, document.createTextNode(` ${(blob.size/1048576).toFixed(1)} MB / ${mimeType}`));
      review.hidden=false; button.disabled=false;
    };
    button.disabled=true;review.hidden=true;recorder.start(1000);
    play(engine,()=>{
      engine.state.mode='paused';engine.state.frozen=true;
      setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},600);
    });
  };
}
