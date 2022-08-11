import rtsp from "rtsp-server";
import naiveEmitter from "naive-emitter";
import dgram from "dgram";

const createFence = () => {
  let waitingFor = [];

  const readyEmitter = naiveEmitter.create();
  const errorEmitter = naiveEmitter.create();

  const addCheckpoint = () => {
    const func = () => {
      waitingFor = waitingFor.filter((entry) => {
        return entry !== func;
      });

      if (waitingFor.length === 0) {
        readyEmitter.emit();
      }
    };

    waitingFor = [...waitingFor, func];

    const failed = ({ error }) => {
      errorEmitter.emit({ error });
    };

    return {
      reached: func,
      failed,
    };
  };

  return {
    onReady: readyEmitter.on,
    onError: errorEmitter.on,

    addCheckpoint,
  };
};

const create = ({ port, sdp }) => {
  const readyEmitter = naiveEmitter.create();
  const sessionEmitter = naiveEmitter.create();
  const errorEmitter = naiveEmitter.create();

  const fence = createFence();
  const videoSocketCheckpoint = fence.addCheckpoint();
  const audioSocketCheckpoint = fence.addCheckpoint();

  const videoSocket = dgram.createSocket("udp6");
  videoSocket.bind(6000, (err) => {
    if (err) {
      videoSocketCheckpoint.failed({ error: err });
    } else {
      videoSocketCheckpoint.reached();
    }
  });
  const audioSocket = dgram.createSocket("udp6");
  audioSocket.bind(6001, (err) => {
    if (err) {
      audioSocketCheckpoint.failed({ error: err });
    } else {
      audioSocketCheckpoint.reached();
    }
  });

  //   const sdp = `
  // v=0
  // c=IN IP4 0.0.0.0
  // m=video 0 RTP/AVP 96
  // a=rtpmap:96 H264/90000
  // a=fmtp:96 profile-level-id=4D4033`.trim();

  const OPTIONS = ({ req, res }) => {
    res.setHeader("Public", "SETUP, TEARDOWN, PLAY");
    res.statusCode = 200;
    res.end();
  };

  const DESCRIBE = ({ req, res }) => {
    res.setHeader("Content-Type", "application/sdp");
    res.setHeader("Content-Length", `${sdp.length}`);
    res.statusCode = 200;
    res.end(sdp);
  };

  let sessions = {};

  let sessionIdCounter = 1;

  const createSession = ({ clientAddress, clientPorts }) => {
    const closeEmitter = naiveEmitter.create();
    const pauseEmitter = naiveEmitter.create();
    const resumeEmitter = naiveEmitter.create();

    // TODO: improve
    const clientVideoPort = clientPorts[0];

    const sendRtpVideoPacket = ({ rtpVideoPacket }) => {
        videoSocket.send(rtpVideoPacket, clientVideoPort, clientAddress);
    };

    let paused = true;

    const isPaused = () => {
        return paused;
    };

    sessionEmitter.emit({
        session: {
            onPause: pauseEmitter.on,
            onResume: resumeEmitter.on,
            onClose: closeEmitter.on,
            
            isPaused,
            sendRtpVideoPacket
        }
    });

    const play = () => {
        if (!paused) {
            return;
        }

        paused = false;
        resumeEmitter.emit();
    };

    const teardown = () => {
        closeEmitter.emit();
    };

    return {
        play,
        teardown
    };
  };

  const parseSetupParameters = ({ parametersRaw }) => {
    let parameters = {};

    parametersRaw.forEach((parameterRaw) => {
      const [key, value] = parameterRaw.split("=");
      parameters = {
        ...parameters,
        [key]: value,
      };
    });

    return parameters;
  };

  const parseClientPorts = ({ client_port }) => {
    const [firstPortAsString, lastPortAsString] = client_port.split("-");

    const firstPort = parseInt(firstPortAsString, 10);
    const lastPort = parseInt(lastPortAsString, 10);

    if (lastPort < firstPort) {
      throw Error("port range must be ascending");
    }

    let clientPorts = [];
    for (let i = firstPort; i <= lastPort; i += 1) {
      clientPorts = [...clientPorts, i];
    }

    return clientPorts;
  };

  const findAndParseSessionParameters = ({ parameters }) => {
    const clientPorts = parseClientPorts({
      client_port: parameters.client_port,
    });

    return {
      clientPorts,
    };
  };

  const SETUP = ({ req, res }) => {
    const [transportSpec, unicastOrMulticast, ...parametersRaw] =
      req.headers.transport.split(";");

    const [transport, profile, lowerTransport] = transportSpec.split("/");

    console.log({
      transportSpec,
      unicastOrMulticast,
      parameters: parametersRaw,
      transport,
      profile,
      lowerTransport,
    });

    if (transport !== "RTP") {
      throw Error(`only RTP transport supported yet`);
    }

    if (profile !== "AVP") {
      throw Error("only AVP profile supported yet");
    }

    if (lowerTransport !== "UDP") {
      throw Error("only UDP lower transport supported yet");
    }

    if (unicastOrMulticast !== "unicast") {
      throw Error("only unicast supported yet");
    }

    const parameters = parseSetupParameters({ parametersRaw });
    console.log("parameters =", parameters);

    const parametersToSend = {
      ...parameters,
      server_port: "6000-6001",
    };

    const { clientPorts } = findAndParseSessionParameters({ parameters });

    console.log("req.socket =", req.socket);

    const session = createSession({
      clientAddress: req.socket.remoteAddress,
      clientPorts,
    });

    const sessionId = sessionIdCounter;
    sessionIdCounter += 1;

    sessions = {
      ...sessions,
      [sessionId]: session,
    };

    req.socket.on("close", () => {
      session.teardown();

      const { [sessionId]: _, ...others } = sessions;
      sessions = { ...others };
    });

    const parametersToSendAsRawList = Object.keys(parametersToSend).map(
      (key) => {
        return `${key}=${parametersToSend[key]}`;
      }
    );

    const transportElementsToSend = [
      "RTP/AVP/UDP",
      "unicast",
      ...parametersToSendAsRawList,
    ];

    console.log({ transport, profile, lowerTransport });
    res.setHeader("Session", `${sessionId}`);
    res.setHeader("Transport", `${transportElementsToSend.join(";")}`);
    res.end();
  };

  const PLAY = ({ req, res }) => {
    const sessionId = parseInt(req.headers.session);
    const session = sessions[sessionId];

    session.play();

    res.setHeader("Range", req.headers.range);
    res.end();
  };

  const TEARDOWN = ({ req, res }) => {
    const sessionId = parseInt(req.headers.session);
    const session = sessions[sessionId];

    session.teardown();

    const { [sessionId]: _, ...others } = sessions;
    sessions = { ...others };

    res.end();
  };

  const methodHandlers = {
    OPTIONS,
    DESCRIBE,
    SETUP,
    PLAY,
    TEARDOWN,
  };

  let closed = false;
  let server = undefined;

  fence.onReady(() => {
    if (closed) {
      return;
    }

    server = rtsp.createServer((req, res) => {
      console.log(req.method, req.headers);

      const methodHandler = methodHandlers[req.method];
      if (!methodHandler) {
        throw Error(`unknown method ${req.method}`);
      }

      methodHandler({ req, res });
    });

    server.listen(port, () => {
      readyEmitter.emit();
    });
  });

  const close = () => {
    videoSocket.close();
    audioSocket.close();
    server?.close();
  };

  return {
    onReady: readyEmitter.on,
    onSession: sessionEmitter.on,
    onError: errorEmitter.on,

    close,
  };
};

export default {
  create,
};
