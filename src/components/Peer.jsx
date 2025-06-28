/*
================================================================================
File: /audio-jambox/frontend/src/components/Peer.jsx
================================================================================
Place this file inside your 'frontend/src/components/' directory.
*/
import React, { useEffect, useRef } from 'react';
import '../styles/Peer.css'; // We'll add some styles for this component

const Peer = ({ peer }) => {
    const audioRef = useRef();

    // When the peer's stream becomes available, attach it to the audio element.
    useEffect(() => {
        if (audioRef.current && peer.stream) {
            audioRef.current.srcObject = peer.stream;
        }
    }, [peer.stream]);

    return (
        <div className={`peer ${peer.isLocal ? 'local' : ''}`}>
            <p>{peer.isLocal ? 'You' : `Musician ${peer.id.substring(0, 5)}...`}</p>
            {/* The audio element for playback. We mute the local user's audio to prevent feedback. */}
            <audio ref={audioRef} autoPlay playsInline muted={peer.isLocal} />
        </div>
    );
};

export default Peer;
