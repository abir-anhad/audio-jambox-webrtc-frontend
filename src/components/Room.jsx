/*
================================================================================
File: /audio-jambox/frontend/src/components/Room.jsx
================================================================================
This version adds a robustness fix by using a more unique key for React components.
*/
import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import Peer from './Peer';

const SERVER_URL = 'https://devvibe.highloka.com:3030';

const Room = ({ roomId, onLeave }) => {
    const socketRef = useRef();
    const deviceRef = useRef();
    const sendTransportRef = useRef();
    const recvTransportRef = useRef(); // Ref for the receive transport

    const [consumers, setConsumers] = useState(new Map());
    const [localStream, setLocalStream] = useState(null);

    // Helper to promisify socket.io requests
    const socketRequest = (type, data = {}) => {
        return new Promise((resolve) => {
            if (socketRef.current) {
                socketRef.current.emit(type, { roomId, ...data }, resolve);
            }
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
            
            if (!deviceRef.current.loaded) {
                await deviceRef.current.load({ routerRtpCapabilities });
            }
            
            // --- 3. Create Mediasoup SEND Transport ---
            const sendTransportParams = await socketRequest('createWebRtcTransport');
            sendTransportRef.current = deviceRef.current.createSendTransport(sendTransportParams);

            sendTransportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await socketRequest('connectWebRtcTransport', { transportId: sendTransportRef.current.id, dtlsParameters });
                    callback();
                } catch (error) {
                    errback(error);
                }
            });

            sendTransportRef.current.on('produce', async (parameters, callback, errback) => {
                try {
                    const { id } = await socketRequest('produce', {
                        transportId: sendTransportRef.current.id,
                        kind: parameters.kind,
                        rtpParameters: parameters.rtpParameters
                    });
                    callback({ id });
                } catch (error) {
                    errback(error);
                }
            });
            
            // --- 4. Create Mediasoup RECV Transport ---
            const recvTransportParams = await socketRequest('createWebRtcTransport');
            recvTransportRef.current = deviceRef.current.createRecvTransport(recvTransportParams);

            recvTransportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    await socketRequest('connectWebRtcTransport', { transportId: recvTransportRef.current.id, dtlsParameters });
                    callback();
                } catch (error) {
                    errback(error);
                }
            });

            // --- 5. Start producing local audio ---
            const audioTrack = stream.getAudioTracks()[0];
            await sendTransportRef.current.produce({ track: audioTrack });

            // --- 6. Consume from existing peers ---
            for (const peerId of peerIds) {
                if (peerId !== socket.id) {
                    consume(peerId);
                }
            }

            // --- 7. Set up socket listeners for dynamic events ---
            socket.on('new-producer', ({ peerId }) => consume(peerId));

            socket.on('peer-closed', ({ peerId }) => {
                setConsumers(prev => {
                    const newConsumers = new Map(prev);
                    for (const [consumerId, consumerData] of newConsumers.entries()) {
                        if (consumerData.peerId === peerId) {
                            consumerData.consumer.close();
                            newConsumers.delete(consumerId);
                        }
                    }
                    return newConsumers;
                });
            });
        };
        
        joinRoom();

        return () => {
            // Cleanup logic
            socketRef.current?.disconnect();
            sendTransportRef.current?.close();
            recvTransportRef.current?.close();
            localStream?.getTracks().forEach(track => track.stop());
        };
    }, [roomId]); // This useEffect runs once on mount

    const consume = async (peerId) => {
        if (!recvTransportRef.current || !deviceRef.current) return;

        const result = await socketRequest('consume', { 
            producerPeerId: peerId, 
            rtpCapabilities: deviceRef.current.rtpCapabilities 
        });

        if (!result || !result.params) { // Check if result and params are valid
            console.error(`Could not consume from peer ${peerId}, server returned invalid data.`);
            return;
        }

        const { params } = result;
        const consumer = await recvTransportRef.current.consume(params);
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
                {/* FIX: Use the unique consumerId for the key */}
                {Array.from(consumers.entries()).map(([consumerId, { peerId, stream }]) => (
                    <Peer key={consumerId} peer={{ id: peerId, stream }} />
                ))}
            </div>
            <button onClick={onLeave} style={{ marginTop: '2rem' }}>Leave Session</button>
        </div>
    );
};

export default Room;
