import { useEffect, useRef, useState } from 'react';
import { Camera, XCircle, AlertCircle, CheckCircle2, SwitchCamera } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';

interface ScannerProps {
  onScanSuccess: (decodedText: string) => void;
  onClose: () => void;
}

interface CameraDevice {
  deviceId: string;
  label: string;
}

export function BarcodeScanner({ onScanSuccess, onClose }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Mantenemos una referencia al callback para que nunca cambie de identidad ni recree effects
  const onScanSuccessRef = useRef(onScanSuccess);
  useEffect(() => {
    onScanSuccessRef.current = onScanSuccess;
  }, [onScanSuccess]);

  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [lastScanned, setLastScanned] = useState<string>('');
  const [scanCount, setScanCount] = useState<number>(0);

  // Listar todas las cámaras del dispositivo
  const loadAvailableCameras = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `Cámara ${index + 1}`
        }));

      setCameras(videoDevices);

      if (videoDevices.length > 0 && !selectedCameraId) {
        // Elegir por defecto la cámara trasera/macro si existe
        const backCam = videoDevices.find((c) => 
          c.label.toLowerCase().includes('back') || 
          c.label.toLowerCase().includes('trasera') || 
          c.label.toLowerCase().includes('environment') ||
          c.label.toLowerCase().includes('macro')
        );
        setSelectedCameraId(backCam ? backCam.deviceId : videoDevices[0].deviceId);
      }
    } catch (e) {
      console.warn('No se pudieron listar cámaras:', e);
    }
  };

  useEffect(() => {
    let isCancelled = false;
    let animFrameId: number;
    let intervalId: ReturnType<typeof setInterval>;
    let isCooldown = false;

    async function startCameraAndScanner() {
      setStatus('loading');
      setErrorMessage('');

      // Detener cualquier stream anterior
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      try {
        const constraints: MediaStreamConstraints = {
          video: selectedCameraId
            ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (isCancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        // Actualizar nombres de las cámaras con permisos ya otorgados
        await loadAvailableCameras();

        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        if (isCancelled) return;
        setStatus('ready');

        // Función cuando se detecta un código
        const processDetection = (code: string) => {
          if (isCooldown || !code) return;
          isCooldown = true;

          if (navigator.vibrate) {
            try { navigator.vibrate(80); } catch {}
          }

          setLastScanned(code);
          setScanCount((prev) => prev + 1);

          // Llamar al callback que actualiza Dexie/Outbox
          onScanSuccessRef.current(code);

          // Cooldown de 1.5s antes de permitir el SIGUIENTE código
          setTimeout(() => {
            isCooldown = false;
          }, 1500);
        };

        // 1. Detección nativa por Hardware (BarcodeDetector en Android/Chrome)
        if ('BarcodeDetector' in window) {
          let detector: any;
          try {
            // @ts-expect-error native API
            detector = new window.BarcodeDetector({
              formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e']
            });
          } catch {
            // @ts-expect-error native API
            detector = new window.BarcodeDetector();
          }

          const scanLoop = async () => {
            if (isCancelled) return;
            if (videoRef.current && videoRef.current.readyState >= 2 && !isCooldown) {
              try {
                const barcodes = await detector.detect(videoRef.current);
                if (barcodes && barcodes.length > 0) {
                  processDetection(barcodes[0].rawValue);
                }
              } catch {
                // frame omitido
              }
            }
            animFrameId = requestAnimationFrame(scanLoop);
          };
          scanLoop();

        } else {
          // 2. Fallback ZXing por software
          const hints = new Map();
          hints.set(DecodeHintType.TRY_HARDER, true);
          const reader = new BrowserMultiFormatReader(hints);

          intervalId = setInterval(async () => {
            if (isCancelled || isCooldown || !videoRef.current || videoRef.current.readyState < 2) {
              return;
            }
            try {
              const result = await reader.decodeOnceFromVideoElement(videoRef.current);
              if (result) {
                processDetection(result.getText());
              }
            } catch {
              // frame sin lectura
            }
          }, 120);
        }

      } catch (err: unknown) {
        console.error('Error al inicializar cámara:', err);
        if (isCancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(
          msg.includes('Permission') || msg.includes('NotAllowed')
            ? 'Permiso de cámara denegado. Concede permisos en tu navegador.'
            : 'No se pudo iniciar la cámara seleccionada. Prueba con otro lente de la lista.'
        );
        setStatus('error');
      }
    }

    startCameraAndScanner();

    return () => {
      isCancelled = true;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (intervalId) clearInterval(intervalId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [selectedCameraId]);

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-3">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden shadow-2xl relative max-h-[90vh]">
        
        {/* Header con contador de escaneos */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">Escáner Continuo</h3>
            {scanCount > 0 && (
              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-mono border border-indigo-500/30">
                {scanCount} leídos
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        {/* Selector de Lentes/Cámaras */}
        {cameras.length > 1 && (
          <div className="px-4 py-2 bg-slate-950/80 border-b border-slate-800/80 flex items-center gap-2 text-xs">
            <SwitchCamera className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="w-full bg-slate-900 text-slate-200 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:border-indigo-500"
            >
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Lente ${c.deviceId.slice(0, 4)}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Visor de Video */}
        <div className="relative w-full aspect-square bg-black overflow-hidden flex items-center justify-center">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            autoPlay
            playsInline
            muted
          />

          {status === 'loading' && (
            <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-2">
              <div className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-slate-400 text-xs">Iniciando cámara...</p>
            </div>
          )}

          {status === 'error' && (
            <div className="absolute inset-0 bg-slate-950 p-4 flex flex-col items-center justify-center gap-2 text-center">
              <AlertCircle className="w-8 h-8 text-rose-400" />
              <p className="text-rose-300 text-xs">{errorMessage}</p>
            </div>
          )}

          {/* Guía visual fija */}
          {status === 'ready' && (
            <div className="absolute inset-8 border-2 border-dashed border-indigo-400/60 rounded-xl pointer-events-none flex items-center justify-center">
              <div className="w-full h-0.5 bg-rose-500/80 shadow shadow-rose-500/50" />
            </div>
          )}
        </div>

        {/* Notificación del último código escaneado */}
        <div className="p-3 bg-slate-900 flex flex-col gap-2">
          {lastScanned ? (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-3 py-2 rounded-lg text-xs flex items-center justify-between">
              <div className="flex items-center gap-2 truncate">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span className="truncate">Último: <b className="font-mono text-white">{lastScanned}</b></span>
              </div>
              <span className="text-[10px] text-emerald-400 font-semibold uppercase animate-pulse">✓ Listo para el siguiente</span>
            </div>
          ) : (
            <p className="text-slate-400 text-[11px] text-center">
              Apunta al código. Puedes escanear varios productos continuamente.
            </p>
          )}

          <button
            onClick={onClose}
            className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition"
          >
            Listo / Terminar
          </button>
        </div>

      </div>
    </div>
  );
}
