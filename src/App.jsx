/*
================================================================================
File: /audio-jambox/frontend/src/App.jsx
================================================================================
*/
import React, { useState } from 'react';
import Room from './components/Room';
import './styles/App.css';

function App() {
    const [roomId, setRoomId] = useState('');
    const [joined, setJoined] = useState(false);

    const handleJoin = () => {
        if (roomId.trim()) {
            setJoined(true);
        }
    };

    return (
        <div className="app-container">
            <h1>Audio JamBox</h1>
            <p>Ultra-low latency audio jamming over the web.</p>
            
            {!joined ? (
                <div id="room-controls">
                    <input
                        type="text"
                        placeholder="Enter Jam Session ID"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                    />
                    <button onClick={handleJoin}>Join Session</button>
                </div>
            ) : (
                <Room roomId={roomId} onLeave={() => setJoined(false)} />
            )}
        </div>
    );
}

export default App;