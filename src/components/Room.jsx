/*
================================================================================
File: /audio-jambox/frontend/src/components/Room.jsx
================================================================================
*/
import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import Peer from './Peer';

const SERVER_URL = 'http://localhost:3001'; // Your backend server URL

const Room = ({ roomId, onLeave }) => {
    const socketRef = useRef();
    const [peers, setPeers] = useState([]);
    const localStreamRef = useRef();
    const peerConnectionsRef = useRef({}); // Using ref to avoid re-renders on update

    useEffect(() => {
        // --- 1. Connect to signaling server and get mic stream ---
        socketRef.current = io(SERVER_URL);

        navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                latency: 0.01
            }
        }).then(stream => {
            localStreamRef.current = stream;
            // Add self to the peer list for UI representation
            setPeers(prev => [...prev, { id: 'local', stream, isLocal: true }]);

            // --- 2. Join the room ---
            socketRef.current.emit('join-room', roomId);

            // --- 3. Set up signaling listeners ---
            setupSignalingListeners();

        }).catch(error => {
            console.error("Error getting user media:", error);
            alert("Could not access microphone. Please check permissions.");
            onLeave();
        });
        
        // --- Cleanup function ---
        return () => {
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (socketRef.current) {
                socketRef.current.disconnect();
            }
             Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
        };
    }, [roomId, onLeave]);

    const setupSignalingListeners = () => {
        const socket = socketRef.current;

        // Fired for all existing users in the room
        socket.on('existing-users', (userIds) => {
            userIds.forEach(async userId => {
                const pc = createPeerConnection(userId);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(new RTCSessionDescription(offer));
                socket.emit('webrtc-offer', { to: userId, offer });
            });
        });

        // Fired when a new user joins
        socket.on('user-joined', (userId) => {
            // New user will send an offer, so we just create the connection obj
            createPeerConnection(userId);
        });

        socket.on('webrtc-offer', async (payload) => {
            const { from, offer } = payload;
            const pc = createPeerConnection(from);
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(new RTCSessionDescription(answer));
            socket.emit('webrtc-answer', { to: from, answer });
        });

        socket.on('webrtc-answer', (payload) => {
            const { from, answer } = payload;
            const pc = peerConnectionsRef.current[from];
            if (pc) {
                pc.setRemoteDescription(new RTCSessionDescription(answer));
            }
        });

        socket.on('webrtc-ice-candidate', (payload) => {
            const { from, candidate } = payload;
            const pc = peerConnectionsRef.current[from];
            if (pc) {
                pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        });

        socket.on('user-left', (userId) => {
            if (peerConnectionsRef.current[userId]) {
                peerConnectionsRef.current[userId].close();
                delete peerConnectionsRef.current[userId];
            }
            setPeers(prevPeers => prevPeers.filter(p => p.id !== userId));
        });
    };

    const createPeerConnection = (remoteUserId) => {
        if (peerConnectionsRef.current[remoteUserId]) {
            return peerConnectionsRef.current[remoteUserId];
        }

        const pc = new RTCPeerConnection({
            iceServers: [
                { 'urls': 'stun:stun.l.google.com:19302' },
                { 'urls': 'stun:stun.stunprotocol.org:3478' },
            ]
        });

        peerConnectionsRef.current = { ...peerConnectionsRef.current, [remoteUserId]: pc };
        
        // Add local stream tracks to the connection
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current);
            });
        }
        
        // Handle incoming remote stream
        pc.ontrack = (event) => {
             setPeers(prev => {
                // Avoid adding duplicates
                if (prev.some(p => p.id === remoteUserId)) return prev;
                return [...prev, { id: remoteUserId, stream: event.streams[0] }];
            });
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socketRef.current.emit('webrtc-ice-candidate', {
                    to: remoteUserId,
                    candidate: event.candidate,
                });
            }
        };

        return pc;
    };
    

    return (
        <div>
            <h2>Jam Session ID: {roomId}</h2>
            <div className="peers-container">
                {peers.map(peer => (
                    <Peer key={peer.id} peer={peer} />
                ))}
            </div>
            <button onClick={onLeave} style={{marginTop: '2rem'}}>Leave Session</button>
        </div>
    );
};

export default Room;