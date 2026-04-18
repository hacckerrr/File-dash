// If deploying the backend separately (e.g. Render), put that URL here:
// Example: const BACKEND_URL = 'my-file-dash-backend.onrender.com';
const BACKEND_URL = 'file-dash-backend.onrender.com'; 

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${BACKEND_URL}`);
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Standard hole-punch
        { urls: 'stun:stun1.l.google.com:19302' },
        // Fallback TURN Relay Servers for strict cellular hotspots (Symmetric NATs)
        {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ]
};

let pc;
let dataChannel;
let roomCode;
let isSender = false;
let iceCandidatesQueue = [];

// UI Elements
const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
const joinInput = document.getElementById('join-code');
const roomCodeDisplay = document.getElementById('room-code-display');
const codeValue = document.getElementById('code-value');
const connectionPanel = document.getElementById('connection-panel');
const filePanel = document.getElementById('file-panel');
const senderArea = document.getElementById('sender-area');
const fileInput = document.getElementById('file-input');
const sendBtn = document.getElementById('send-btn');
const statusText = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressContainer = document.getElementById('progress-container');

// WebSocket Handlers
ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
        case 'room-created':
            roomCode = msg.code;
            codeValue.textContent = roomCode;
            roomCodeDisplay.classList.remove('hidden');
            statusText.textContent = "Waiting for peer to join...";
            createBtn.disabled = true;
            break;

        case 'peer-joined': // Sent to Sender
            statusText.textContent = "Peer joined! Connecting...";
            startWebRTC(true);
            break;

        case 'room-joined': // Sent to Receiver
            statusText.textContent = "Joined! Connecting...";
            startWebRTC(false);
            break;

        case 'signal':
            handleSignal(msg.data);
            break;

        case 'peer-disconnected':
            alert("Peer disconnected. Reload to start over.");
            location.reload();
            break;

        case 'error':
            alert(msg.message);
            break;
    }
};

createBtn.onclick = () => {
    isSender = true;
    ws.send(JSON.stringify({ type: 'create-room' }));
};

joinBtn.onclick = () => {
    const code = joinInput.value;
    if (code.length === 5) {
        ws.send(JSON.stringify({ type: 'join-room', code }));
    } else {
        alert("Enter a valid 5-digit code");
    }
};

async function startWebRTC(initiator) {
    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: 'signal', data: { candidate: event.candidate } }));
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            connectionPanel.classList.add('hidden');
            filePanel.classList.remove('hidden');
            senderArea.classList.remove('hidden'); // Show for both
            statusText.textContent = "Connected securely! Ready to transfer.";
        }
    };

    if (initiator) {
        // Sender creates DataChannel
        dataChannel = pc.createDataChannel("fileTransfer");
        setupDataChannel(dataChannel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'signal', data: { sdp: offer } }));
    } else {
        // Receiver waits for DataChannel
        pc.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannel(dataChannel);
        };
    }
}

async function handleSignal(data) {
    if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        
        while (iceCandidatesQueue.length) {
            try {
                await pc.addIceCandidate(iceCandidatesQueue.shift());
            } catch (e) {
                console.error("Error adding queued ice candidate", e);
            }
        }

        if (data.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'signal', data: { sdp: answer } }));
        }
    } else if (data.candidate) {
        const rtcCandidate = new RTCIceCandidate(data.candidate);
        if (pc.remoteDescription) {
            try {
                await pc.addIceCandidate(rtcCandidate);
            } catch (e) {
                console.error("Error adding ice candidate", e);
            }
        } else {
            iceCandidatesQueue.push(rtcCandidate);
        }
    }
}

// File Transfer Logic
const CHUNK_SIZE = 16 * 1024; // 16KB
let receivedChunks = [];
let receivedSize = 0;
let fileMeta = {};

function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => console.log("Data channel open");
    channel.onclose = () => console.log("Data channel closed");

    channel.onmessage = handleReceiveMessage;
}

fileInput.onchange = () => {
    if (fileInput.files.length > 0) {
        sendBtn.disabled = false;
        statusText.textContent = `Selected: ${fileInput.files[0].name}`;
    } else {
        sendBtn.disabled = true;
        statusText.textContent = "Connected securely! Ready to transfer.";
    }
};

sendBtn.onclick = () => {
    const file = fileInput.files[0];
    if (!file || !dataChannel) return;

    statusText.textContent = `Sending ${file.name}...`;
    progressContainer.classList.remove('hidden');
    sendBtn.disabled = true;
    fileInput.disabled = true; // Half-duplex: disable selecting new file while sending

    // Send metadata first
    dataChannel.send(JSON.stringify({
        type: 'meta',
        name: file.name,
        size: file.size,
        fileType: file.type
    }));

    sendFile(file);
};

    function sendFile(file) {
    let offset = 0;
    const reader = new FileReader();

    const readSlice = (o) => {
        const slice = file.slice(o, o + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
    };

    const sendChunk = (chunk) => {
        // Backpressure check to prevent crashing on large files
        // Browsers close the channel if this buffer hits around 16MB.
        const BUFFER_THRESHOLD = 1 * 1024 * 1024; // 1MB 
        
        if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
            setTimeout(() => sendChunk(chunk), 50);
            return;
        }

        try {
            dataChannel.send(chunk);
        } catch (e) {
            console.error("Error sending chunk: ", e);
            statusText.textContent = "Error sending file!";
            fileInput.disabled = false;
            sendBtn.disabled = true;
            return;
        }
        
        offset += chunk.byteLength;
        updateProgress(offset, file.size);

        if (offset < file.size) {
            readSlice(offset);
        } else {
            statusText.textContent = "Transfer Complete! Ready for next file.";
            dataChannel.send(JSON.stringify({ type: 'end' }));
            fileInput.value = '';
            sendBtn.disabled = true;
            fileInput.disabled = false; // Re-enable for the next file
        }
    };

    reader.onload = (e) => {
        sendChunk(e.target.result);
    };

    readSlice(0);
}

function handleReceiveMessage(event) {
    const data = event.data;

    if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'meta') {
            fileMeta = msg;
            receivedChunks = [];
            receivedSize = 0;
            statusText.textContent = `Receiving ${fileMeta.name}...`;
            progressContainer.classList.remove('hidden');
            sendBtn.disabled = true; // Half-duplex: block local sending
            fileInput.disabled = true; 
        } else if (msg.type === 'end') {
            saveFile();
        }
    } else {
        // Binary Chunk
        receivedChunks.push(data);
        receivedSize += data.byteLength;
        updateProgress(receivedSize, fileMeta.size);
    }
}

function updateProgress(current, total) {
    const percent = Math.floor((current / total) * 100);
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
}

function saveFile() {
    statusText.textContent = "File Received! Saving...";
    const blob = new Blob(receivedChunks, { type: fileMeta.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileMeta.name || 'received_file';
    a.click();
    URL.revokeObjectURL(url);
    statusText.textContent = "Download Started! Ready for another file.";
    
    // Half-duplex: Re-enable UI for the next transfer
    fileInput.disabled = false;
    if (fileInput.files.length > 0) {
        sendBtn.disabled = false;
    }
}
