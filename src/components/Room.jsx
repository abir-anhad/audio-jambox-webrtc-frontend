/*
================================================================================
File: /audio-jambox/frontend/src/components/Room.jsx
================================================================================
This version is refactored to request stereo audio, matching the new config.
*/
import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import Peer from './Peer';

const SERVER_URL = 'https://devvibe.highloka.com:3030'; // Your server URL

const Room = ({ roomId, onLeave }) => {
    const socketRef = useRef();
    const deviceRef = useRef();
    const sendTransportRef = useRef();
    const recvTransportRef = useRef();

    const [consumers, setConsumers] = useState(new Map());
    const [localStream, setLocalStream] = useState(null);
    const peerIdRef = useRef(null);

    const log = (msg) => console.log(`[CLIENT:${peerIdRef.current || 'unassigned'}] ${new Date().toISOString()} - ${msg}`);
    const errorLog = (msg, err) => console.error(`[CLIENT-ERROR:${peerIdRef.current || 'unassigned'}] ${new Date().toISOString()} - ${msg}`, err);

    const socketRequest = (type, data = {}) => {
        return new Promise((resolve, reject) => {
            if (socketRef.current) {
                socketRef.current.emit(type, { roomId, ...data }, (response) => {
                    if (response && response.error) {
                        errorLog(`Request [${type}] failed on server`, response.error);
                        reject(response.error);
                    } else {
                        resolve(response);
                    }
                });
            } else {
                reject('Socket not connected');
            }
        });
    };

    useEffect(() => {
        const joinRoom = async () => {
            try {
                log('Starting joinRoom process...');
                // *** THE CRITICAL CHANGE IS HERE ***
                // Requesting a stereo audio track to match the new server configuration.
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: { 
                        echoCancellation: false, 
                        noiseSuppression: false, 
                        autoGainControl: false,
                        channelCount: 2 // Request stereo audio from the microphone
                    } 
                });
                log('Got user media stream');
                setLocalStream(stream);

                socketRef.current = io(SERVER_URL);
                const socket = socketRef.current;
                
                socket.on('connect', async () => {
                    peerIdRef.current = socket.id;
                    log('Socket connected successfully!');
                    deviceRef.current = new mediasoupClient.Device();
                    
                    const { peerIds } = await socketRequest('join');
                    log(`Joined room, existing peers: [${peerIds.join(', ')}]`);
                    
                    const routerRtpCapabilities = await socketRequest('getRouterRtpCapabilities');
                    log('Got router RTP capabilities');
                    
                    if (!deviceRef.current.loaded) {
                        await deviceRef.current.load({ routerRtpCapabilities });
                        log('Mediasoup device loaded');
                    }
                    
                    const sendTransportParams = await socketRequest('createWebRtcTransport');
                    sendTransportRef.current = deviceRef.current.createSendTransport(sendTransportParams);

                    sendTransportRef.current.on('connect', (p, cb, eb) => socketRequest('connectWebRtcTransport', { transportId: sendTransportRef.current.id, dtlsParameters: p.dtlsParameters }).then(cb).catch(eb));
                    sendTransportRef.current.on('produce', (p, cb, eb) => socketRequest('produce', { transportId: sendTransportRef.current.id, kind: p.kind, rtpParameters: p.rtpParameters }).then(({id}) => cb({id})).catch(eb));
                    
                    const recvTransportParams = await socketRequest('createWebRtcTransport');
                    recvTransportRef.current = deviceRef.current.createRecvTransport(recvTransportParams);
                    recvTransportRef.current.on('connect', (p, cb, eb) => socketRequest('connectWebRtcTransport', { transportId: recvTransportRef.current.id, dtlsParameters: p.dtlsParameters }).then(cb).catch(eb));

                    const audioTrack = stream.getAudioTracks()[0];
                    await sendTransportRef.current.produce({ track: audioTrack });
                    log('Local audio track produced.');

                    for (const peerId of peerIds) {
                        if (peerId !== socket.id) consume(peerId);
                    }
                });

                socket.on('new-producer', ({ peerId }) => {
                    log(`<< Received 'new-producer' from [${peerId}]`);
                    consume(peerId);
                });

                socket.on('peer-closed', ({ peerId }) => {
                    log(`<< Received 'peer-closed' from [${peerId}]`);
                    setConsumers(prev => {
                        const newConsumers = new Map(prev);
                        newConsumers.forEach((consumerData, consumerId) => {
                            if (consumerData.peerId === peerId) {
                                consumerData.consumer.close();
                                newConsumers.delete(consumerId);
                            }
                        });
                        return newConsumers;
                    });
                });
            } catch (err) {
                errorLog('Error during joinRoom process', err);
            }
        };
        
        joinRoom();

        return () => {
            log('Cleaning up Room component...');
            socketRef.current?.disconnect();
            sendTransportRef.current?.close();
            recvTransportRef.current?.close();
            localStream?.getTracks().forEach(track => track.stop());
        };
    }, [roomId]);

    const consume = async (peerId) => {
        log(`Attempting to consume from peer [${peerId}]`);
        if (!recvTransportRef.current || !deviceRef.current?.loaded) return;

        const result = await socketRequest('consume', { producerPeerId: peerId, rtpCapabilities: deviceRef.current.rtpCapabilities });
        if (!result || !result.params) return;

        const consumer = await recvTransportRef.current.consume(result.params);
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
                {Array.from(consumers.entries()).map(([consumerId, { peerId, stream }]) => (
                    <Peer key={consumerId} peer={{ id: peerId, stream }} />
                ))}
            </div>
            <button onClick={onLeave} style={{ marginTop: '2rem' }}>Leave Session</button>
        </div>
    );
};

export default Room;
