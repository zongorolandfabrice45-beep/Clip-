import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// State
let clips = [];
let selectedClipId = null;
let ffmpeg = null;
let isExporting = false;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const dropArea = document.getElementById('dropArea');
const clipCount = document.getElementById('clipCount');
const preview = document.getElementById('preview');
const selectedLabel = document.getElementById('selectedLabel');
const startInput = document.getElementById('startInput');
const endInput = document.getElementById('endInput');
const setStartBtn = document.getElementById('setStartBtn');
const setEndBtn = document.getElementById('setEndBtn');
const applyCut = document.getElementById('applyCut');
const clipList = document.getElementById('clipList');
const smartOrder = document.getElementById('smartOrder');
const shuffleBtn = document.getElementById('shuffleBtn');
const storyMode = document.getElementById('storyMode');
const analysisStatus = document.getElementById('analysisStatus');
const aiSummaryBox = document.getElementById('aiSummaryBox');
const aiSummaryText = document.getElementById('aiSummaryText');
const projectName = document.getElementById('projectName');
const exportBtn = document.getElementById('exportBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('status');
const exportResult = document.getElementById('exportResult');
const finalPreview = document.getElementById('finalPreview');
const downloadLink = document.getElementById('downloadLink');

// API Key Elements
const apiKeyBtn = document.getElementById('apiKeyBtn');
const apiKeyModal = document.getElementById('apiKeyModal');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');
const apiStatusDot = document.getElementById('apiStatusDot');
const apiKeyStatusText = document.getElementById('apiKeyStatusText');

const STORAGE_KEY = 'CLIPGENIUS_GEMINI_KEY';

// --- API Key Management ---
function updateApiStatus() {
  const key = localStorage.getItem(STORAGE_KEY);
  if (key && key.trim().length > 0) {
    apiStatusDot.classList.add('active');
    apiKeyStatusText.textContent = 'IA Active';
  } else {
    apiStatusDot.classList.remove('active');
    apiKeyStatusText.textContent = 'Clé IA';
  }
}

apiKeyBtn.addEventListener('click', () => {
  apiKeyInput.value = localStorage.getItem(STORAGE_KEY) || '';
  apiKeyModal.showModal();
});

apiKeyModal.addEventListener('click', (e) => {
  if (e.target === apiKeyModal) apiKeyModal.close();
});

saveApiKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    localStorage.setItem(STORAGE_KEY, key);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  updateApiStatus();
  apiKeyModal.close();
});

clearApiKeyBtn.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  apiKeyInput.value = '';
  updateApiStatus();
  apiKeyModal.close();
});

updateApiStatus();

// --- Helper: Extract Thumbnail & Frames from Video ---
async function extractVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    video.onloadedmetadata = async () => {
      const duration = video.duration || 1;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const width = Math.min(video.videoWidth || 320, 320);
      const height = Math.floor(width * ((video.videoHeight || 180) / (video.videoWidth || 320)));
      canvas.width = width;
      canvas.height = height;

      // Extract 3 sample frames for AI analysis (at 15%, 50%, 85%)
      const samplePoints = [
        Math.max(0.1, duration * 0.15),
        duration * 0.5,
        Math.min(duration - 0.1, duration * 0.85)
      ];

      const frames = [];
      let thumbUrl = '';

      for (let i = 0; i < samplePoints.length; i++) {
        await new Promise((resSeek) => {
          video.currentTime = samplePoints[i];
          video.onseeked = () => {
            ctx.drawImage(video, 0, 0, width, height);
            const base64 = canvas.toDataURL('image/jpeg', 0.65);
            frames.push(base64);
            if (i === 1 || !thumbUrl) thumbUrl = base64;
            resSeek();
          };
        });
      }

      resolve({
        duration: Math.round(duration * 10) / 10,
        thumbUrl,
        frames,
        url
      });
    };

    video.onerror = () => reject(new Error(`Impossible de lire la vidéo ${file.name}`));
  });
}

// --- Import Clips ---
async function handleFiles(fileList) {
  const newFiles = Array.from(fileList).filter(f => f.type.startsWith('video/'));
  if (newFiles.length === 0) return;

  statusText.textContent = `Chargement de ${newFiles.length} clip(s)...`;

  for (const file of newFiles) {
    try {
      const meta = await extractVideoMetadata(file);
      const clip = {
        id: 'clip_' + Math.random().toString(36).substr(2, 9),
        file,
        name: file.name,
        duration: meta.duration,
        start: 0,
        end: meta.duration,
        url: meta.url,
        thumbUrl: meta.thumbUrl,
        frames: meta.frames,
        aiTag: '',
        aiSummary: ''
      };
      clips.push(clip);
    } catch (err) {
      console.error(err);
    }
  }

  updateClipUI();
  if (!selectedClipId && clips.length > 0) {
    selectClip(clips[0].id);
  }
}

fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  fileInput.value = '';
});

dropArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropArea.classList.add('dragover');
});

dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));

dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('dragover');
  if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
});

// --- UI Updates ---
function updateClipUI() {
  clipCount.textContent = `${clips.length} clip${clips.length > 1 ? 's' : ''}`;
  const hasClips = clips.length > 0;
  smartOrder.disabled = !hasClips;
  shuffleBtn.disabled = !hasClips;
  exportBtn.disabled = !hasClips;

  if (clips.length === 0) {
    clipList.innerHTML = '<div class="empty">Tes clips apparaîtront ici.</div>';
    selectedLabel.textContent = 'Sélectionne un clip pour le prévisualiser.';
    applyCut.disabled = true;
    preview.src = '';
    return;
  }

  clipList.innerHTML = '';
  clips.forEach((clip, index) => {
    const card = document.createElement('div');
    card.className = `clip-card ${clip.id === selectedClipId ? 'active' : ''}`;
    card.onclick = () => selectClip(clip.id);

    const cutDuration = Math.max(0.1, Math.round((clip.end - clip.start) * 10) / 10);

    card.innerHTML = `
      <img src="${clip.thumbUrl}" class="clip-thumb" alt="${clip.name}" />
      <div class="clip-details">
        <div class="clip-title-row">
          <span class="clip-order-badge">#${index + 1}</span>
          <span class="clip-title" title="${clip.name}">${clip.name}</span>
        </div>
        <div class="clip-sub">
          <span>${cutDuration}s</span>
          <span>(${clip.start}s - ${clip.end}s)</span>
        </div>
        ${clip.aiTag ? `<span class="ai-tag">✦ ${clip.aiTag}</span>` : ''}
      </div>
      <div class="clip-controls" onclick="event.stopPropagation()">
        <button class="icon-btn" title="Monter" onclick="window.moveClip(${index}, -1)" ${index === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" title="Descendre" onclick="window.moveClip(${index}, 1)" ${index === clips.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="icon-btn delete" title="Supprimer" onclick="window.removeClip('${clip.id}')">✕</button>
      </div>
    `;
    clipList.appendChild(card);
  });
}

function selectClip(id) {
  selectedClipId = id;
  const clip = clips.find(c => c.id === id);
  if (!clip) return;

  preview.src = clip.url;
  selectedLabel.textContent = `Clip actif : ${clip.name} (${clip.duration}s)`;
  startInput.max = clip.duration;
  endInput.max = clip.duration;
  startInput.value = clip.start;
  endInput.value = clip.end;
  applyCut.disabled = false;

  updateClipUI();
}

window.moveClip = (index, dir) => {
  const target = index + dir;
  if (target < 0 || target >= clips.length) return;
  const [removed] = clips.splice(index, 1);
  clips.splice(target, 0, removed);
  updateClipUI();
};

window.removeClip = (id) => {
  clips = clips.filter(c => c.id !== id);
  if (selectedClipId === id) {
    selectedClipId = clips.length > 0 ? clips[0].id : null;
    if (selectedClipId) selectClip(selectedClipId);
  }
  updateClipUI();
};

// --- Preview & Cut Controls ---
setStartBtn.addEventListener('click', () => {
  startInput.value = Math.round(preview.currentTime * 10) / 10;
});

setEndBtn.addEventListener('click', () => {
  endInput.value = Math.round(preview.currentTime * 10) / 10;
});

applyCut.addEventListener('click', () => {
  const clip = clips.find(c => c.id === selectedClipId);
  if (!clip) return;

  let s = parseFloat(startInput.value) || 0;
  let e = parseFloat(endInput.value) || clip.duration;

  if (s < 0) s = 0;
  if (e > clip.duration) e = clip.duration;
  if (s >= e) {
    alert('Le temps de début doit être inférieur au temps de fin.');
    return;
  }

  clip.start = Math.round(s * 10) / 10;
  clip.end = Math.round(e * 10) / 10;
  updateClipUI();
});

preview.addEventListener('timeupdate', () => {
  const clip = clips.find(c => c.id === selectedClipId);
  if (clip && preview.currentTime > clip.end) {
    preview.pause();
    preview.currentTime = clip.start;
  }
});

// --- Reorder & Shuffle ---
shuffleBtn.addEventListener('click', () => {
  for (let i = clips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clips[i], clips[j]] = [clips[j], clips[i]];
  }
  updateClipUI();
});

// --- AI Analysis via Gemini 2.5 Flash ---
smartOrder.addEventListener('click', async () => {
  if (clips.length === 0) return;

  const apiKey = localStorage.getItem(STORAGE_KEY);
  if (!apiKey) {
    apiKeyModal.showModal();
    analysisStatus.textContent = 'ℹ️ Ajoute ta clé API Google Gemini pour activer l’IA.';
    return;
  }

  smartOrder.disabled = true;
  analysisStatus.textContent = '✦ Analyse des scènes en cours avec Gemini 2.5 Flash...';

  try {
    // Build Gemini multimodal request
    const parts = [
      {
        text: `Tu es un monteur vidéo expert. L'utilisateur veut réaliser un montage vidéo de style "${storyMode.value}".
Tu as reçu des captures d'images clés pour ${clips.length} clips vidéo.
Voici la liste des clips avec leurs identifiants :
${clips.map((c, i) => `Clip ${i} (ID: "${c.id}", nom: "${c.name}", durée totale: ${c.duration}s)`).join('\n')}

Instructions :
1. Analyse le contenu visuel et l'action de chaque clip.
2. Détermine le meilleur ordre de montage pour un résultat captivant et fluide.
3. Propose un point de début (suggestedStart) et de fin (suggestedEnd) pour chaque clip afin d'éliminer les temps morts.
4. Rédige un court résumé du scénario en français.

Réponds EXCLUSIVEMENT sous forme d'un objet JSON valide respectant cette structure exacte, sans markdown additionnel :
{
  "storyline": "Résumé en 1-2 phrases du fil conducteur de la vidéo",
  "order": ["id_clip_1", "id_clip_2", ...],
  "clips": [
    { "id": "id_du_clip", "tag": "ex: Intro dynamique", "suggestedStart": 0, "suggestedEnd": 3.5 }
  ]
}`
      }
    ];

    // Append representative frame for each clip
    clips.forEach((clip, index) => {
      const frameBase64 = clip.thumbUrl.split(',')[1];
      if (frameBase64) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: frameBase64
          }
        });
        parts.push({
          text: `[Image ci-dessus correspond au Clip ${index} - ID: "${clip.id}"]`
        });
      }
    });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Erreur API Gemini (${response.status})`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Réponse vide de Gemini');

    const result = JSON.parse(rawText);

    // Apply AI suggestions
    if (result.storyline) {
      aiSummaryBox.hidden = false;
      aiSummaryText.textContent = result.storyline;
    }

    if (Array.isArray(result.clips)) {
      result.clips.forEach(suggested => {
        const target = clips.find(c => c.id === suggested.id);
        if (target) {
          if (suggested.tag) target.aiTag = suggested.tag;
          if (typeof suggested.suggestedStart === 'number' && suggested.suggestedStart >= 0) {
            target.start = Math.max(0, Math.min(suggested.suggestedStart, target.duration));
          }
          if (typeof suggested.suggestedEnd === 'number' && suggested.suggestedEnd > target.start) {
            target.end = Math.min(target.duration, suggested.suggestedEnd);
          }
        }
      });
    }

    // Reorder clips if specified
    if (Array.isArray(result.order) && result.order.length > 0) {
      const ordered = [];
      result.order.forEach(id => {
        const found = clips.find(c => c.id === id);
        if (found) ordered.push(found);
      });
      // Append any remaining clips that were not in the order list
      clips.forEach(c => {
        if (!ordered.includes(c)) ordered.push(c);
      });
      clips = ordered;
    }

    analysisStatus.textContent = '✓ Clips analysés et ordonnés avec succès par Gemini !';
    updateClipUI();
    if (selectedClipId) selectClip(selectedClipId);

  } catch (err) {
    console.error('Erreur IA:', err);
    analysisStatus.textContent = `⚠️ Erreur : ${err.message}`;
  } finally {
    smartOrder.disabled = false;
  }
});

// --- FFmpeg WASM Video Export ---
async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;

  statusText.textContent = 'Téléchargement du moteur FFmpeg WebAssembly...';
  ffmpeg = new FFmpeg();

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(progress * 100);
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    statusText.textContent = `Encodage vidéo en cours (${pct}%)...`;
  });

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
  });

  return ffmpeg;
}

exportBtn.addEventListener('click', async () => {
  if (clips.length === 0 || isExporting) return;

  isExporting = true;
  exportBtn.disabled = true;
  progressWrap.hidden = false;
  exportResult.hidden = true;
  progressBar.style.width = '0%';

  try {
    const ff = await initFFmpeg();

    // 1. Process and trim each clip
    const cutFilenames = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const inName = `input_${i}.mp4`;
      const outName = `cut_${i}.mp4`;

      statusText.textContent = `Préparation du clip ${i + 1}/${clips.length}...`;
      await ff.writeFile(inName, await fetchFile(clip.file));

      // Fast trim with stream copy, fallback to re-encode if keyframes misalignment
      statusText.textContent = `Découpe du clip ${i + 1}/${clips.length}...`;
      const trimDuration = (clip.end - clip.start).toFixed(2);
      
      // Try fast re-encode for consistent dimensions/fps
      await ff.exec([
        '-ss', `${clip.start}`,
        '-i', inName,
        '-t', `${trimDuration}`,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '44100',
        '-r', '30',
        outName
      ]);

      cutFilenames.push(outName);
      await ff.deleteFile(inName);
    }

    // 2. Concat demuxer
    statusText.textContent = 'Assemblage des clips en cours...';
    const concatContent = cutFilenames.map(name => `file '${name}'`).join('\n');
    await ff.writeFile('concat.txt', concatContent);

    const outFileName = `${(projectName.value.trim() || 'clipgenius-montage')}.mp4`;

    await ff.exec([
      '-f', 'concat',
      '-safe', '0',
      '-i', 'concat.txt',
      '-c', 'copy',
      'final.mp4'
    ]);

    // 3. Read output
    statusText.textContent = 'Finalisation du fichier MP4...';
    const data = await ff.readFile('final.mp4');
    const videoBlob = new Blob([data.buffer], { type: 'video/mp4' });
    const videoUrl = URL.createObjectURL(videoBlob);

    finalPreview.src = videoUrl;
    downloadLink.href = videoUrl;
    downloadLink.download = outFileName;
    downloadLink.textContent = `Télécharger "${outFileName}" (${Math.round(videoBlob.size / 1024 / 1024 * 10) / 10} Mo)`;

    // Cleanup FFmpeg virtual files
    for (const name of cutFilenames) {
      try { await ff.deleteFile(name); } catch (_) {}
    }
    try { await ff.deleteFile('concat.txt'); } catch (_) {}
    try { await ff.deleteFile('final.mp4'); } catch (_) {}

    progressBar.style.width = '100%';
    statusText.textContent = '✓ Montage terminé avec succès !';
    exportResult.hidden = false;

  } catch (err) {
    console.error('Erreur export FFmpeg:', err);
    statusText.textContent = `Erreur d'export : ${err.message}`;
  } finally {
    isExporting = false;
    exportBtn.disabled = false;
  }
});
