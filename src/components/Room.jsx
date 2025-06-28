/*
================================================================================
File: /audio-jambox/frontend/src/components/Room.jsx
================================================================================
The core client component, completely refactored for Mediasoup.
*/
import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import Peer from './Peer';

const SERVER_URL = 'https://devvibe.highloka.com:3030';

const Room = ({ roomId, onLeave }) => {
    const socketRef = useRef();
    const deviceRef = useRef();
    const transportRef = useRef();
    const [consumers, setConsumers] = useState(new Map());
    const [localStream, setLocalStream] = useState(null);

    // Helper to promisify socket.io requests
    const socketRequest = (type, data = {}) => {
        return new Promise((resolve) => {
            socketRef.current.emit(type, { roomId, ...data }, resolve);
        });
    };

    useEffect(() => {
        const joinRoom = async () => {
            // --- 1. Get mic stream ---
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } 
            });
            setLocalStream(stream);

            // --- 2. Connect to signaling server & initialize ---
            socketRef.current = io(SERVER_URL);
            const socket = socketRef.current;
            deviceRef.current = new mediasoupClient.Device();
            
            const { peerIds } = await socketRequest('join');
            const routerRtpCapabilities = await socketRequest('getRouterRtpCapabilities');
            await deviceRef.current.load({ routerRtpCapabilities });
            
            // --- 3. Create Mediasoup Transport ---
            const transportParams = await socketRequest('createWebRtcTransport');
            transportRef.current = deviceRef.current.createSendTransport(transportParams);

            transportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await socketRequest('connectWebRtcTransport', { transportId: transportRef.current.id, dtlsParameters });
                    callback();
                } catch (error) {
                    errback(error);
                }
            });

            transportRef.current.on('produce', async (parameters, callback, errback) => {
                try {
                    const { id } = await socketRequest('produce', {
                        transportId: transportRef.current.id,
                        kind: parameters.kind,
                        rtpParameters: parameters.rtpParameters
                    });
                    callback({ id });
                } catch (error) {
                    errback(error);
                }
            });
            
            // --- 4. Start producing local audio ---
            const audioTrack = stream.getAudioTracks()[0];
            await transportRef.current.produce({ track: audioTrack });

            // --- 5. Consume existing peers ---
            for (const peerId of peerIds) {
                if (peerId !== socket.id) consume(peerId);
            }
            
            // --- 6. Set up socket listeners for dynamic events ---
            socket.on('new-producer', ({ peerId, producerId }) => consume(peerId));
            socket.on('peer-closed', ({ peerId }) => {
                setConsumers(prev => {
                    const newConsumers = new Map(prev);
                    for (const [consumerId, consumerData] of newConsumers.entries()) {
                        if (consumerData.peerId === peerId) {
                            newConsumers.delete(consumerId);
                        }
                    }
                    return newConsumers;
                });
            });
        };
        
        joinRoom();

        return () => {
            socketRef.current?.disconnect();
            transportRef.current?.close();
            localStream?.getTracks().forEach(track => track.stop());
        };
    }, [roomId]);

    const consume = async (peerId) => {
        const { params } = await socketRequest('consume', { producerPeerId: peerId, rtpCapabilities: deviceRef.current.rtpCapabilities });
        if (!params) return;

        const consumer = await transportRef.current.consume(params);
        await socketRequest('resume', { consumerId: consumer.id });

        const { track } = consumer;
        const stream = new MediaStream([track]);
        setConsumers(prev => new Map(prev).set(consumer.id, { peerId, stream, consumer }));
    };

    return (
        <div>
            <h2>Jam Session ID: {roomId}</h2>
            <div className="peers-container">
                {localStream && <Peer peer={{ id: 'local', stream: localStream, isLocal: true }} />}
                {Array.from(consumers.values()).map(({ peerId, stream }) => (
                    <Peer key={peerId} peer={{ id: peerId, stream }} />
                ))}
            </div>
            <button onClick={onLeave} style={{ marginTop: '2rem' }}>Leave Session</button>
        </div>
    );
};

export default Room;