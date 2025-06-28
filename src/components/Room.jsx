/*
================================================================================
File: /audio-jambox/frontend/src/components/Room.jsx
================================================================================
This version has been instrumented with extensive logging.
*/
import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import Peer from './Peer';

const SERVER_URL = 'https://devvibe.highloka.com:3030'; // Replace with your server URL

const Room = ({ roomId, onLeave }) => {
    const socketRef = useRef();
    const deviceRef = useRef();
    const sendTransportRef = useRef();
    const recvTransportRef = useRef();

    const [consumers, setConsumers] = useState(new Map());
    const [localStream, setLocalStream] = useState(null);
    const peerIdRef = useRef(null);

    const log = (msg) => console.log(`[CLIENT:${peerIdRef.current || 'unassigned'}] ${new Date().toISOString()} - ${msg}`);
    const error = (msg, err) => console.error(`[CLIENT-ERROR:${peerIdRef.current || 'unassigned'}] ${new Date().toISOString()} - ${msg}`, err);

    const socketRequest = (type, data = {}) => {
        return new Promise((resolve, reject) => {
            if (socketRef.current) {
                log(`>> Emitting [${type}]`);
                socketRef.current.emit(type, { roomId, ...data }, (response) => {
                    if (response && response.error) {
                        error(`Request [${type}] failed on server`, response.error);
                        reject(response.error);
                    } else {
                        log(`<< Received response for [${type}]`);
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
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
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
                    
                    // --- Create Send Transport ---
                    const sendTransportParams = await socketRequest('createWebRtcTransport');
                    log(`Send transport params received [id:${sendTransportParams.id}]`);
                    sendTransportRef.current = deviceRef.current.createSendTransport(sendTransportParams);

                    sendTransportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
                        log('Send transport attempting to connect...');
                        socketRequest('connectWebRtcTransport', { transportId: sendTransportRef.current.id, dtlsParameters })
                            .then(callback)
                            .catch(errback);
                    });

                    sendTransportRef.current.on('produce', async (parameters, callback, errback) => {
                        log('Send transport attempting to produce...');
                        try {
                            const { id } = await socketRequest('produce', { transportId: sendTransportRef.current.id, kind: parameters.kind, rtpParameters: parameters.rtpParameters });
                            log(`Local producer created on server [id:${id}]`);
                            callback({ id });
                        } catch (err) {
                            errback(err);
                        }
                    });

                    // --- Create Recv Transport ---
                    const recvTransportParams = await socketRequest('createWebRtcTransport');
                    log(`Recv transport params received [id:${recvTransportParams.id}]`);
                    recvTransportRef.current = deviceRef.current.createRecvTransport(recvTransportParams);

                    recvTransportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
                        log('Recv transport attempting to connect...');
                        socketRequest('connectWebRtcTransport', { transportId: recvTransportRef.current.id, dtlsParameters })
                            .then(callback)
                            .catch(errback);
                    });

                    // --- Produce local audio ---
                    const audioTrack = stream.getAudioTracks()[0];
                    log('Producing local audio track...');
                    await sendTransportRef.current.produce({ track: audioTrack });
                    log('Local audio track produced.');

                    // --- Consume existing peers ---
                    log(`Consuming from ${peerIds.length} existing peers...`);
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
                        for (const [consumerId, consumerData] of newConsumers.entries()) {
                            if (consumerData.peerId === peerId) {
                                consumerData.consumer.close();
                                newConsumers.delete(consumerId);
                                log(`Closed and removed consumer for peer [${peerId}]`);
                            }
                        }
                        return newConsumers;
                    });
                });
            } catch (err) {
                error('Error during joinRoom process', err);
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
        if (!recvTransportRef.current || !deviceRef.current || !deviceRef.current.loaded) {
            error('Cannot consume, recvTransport or device not ready');
            return;
        }

        const result = await socketRequest('consume', { producerPeerId: peerId, rtpCapabilities: deviceRef.current.rtpCapabilities });
        if (!result || !result.params) {
            error(`Could not consume from peer [${peerId}], server returned invalid data.`);
            return;
        }

        const { params } = result;
        const consumer = await recvTransportRef.current.consume(params);
        log(`Consumer created on client [id:${consumer.id}], kind: ${consumer.kind}`);
        
        await socketRequest('resume', { consumerId: consumer.id });

        const { track } = consumer;
        const stream = new MediaStream([track]);
        log(`Received remote track for peer [${peerId}], setting new consumer state.`);
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
