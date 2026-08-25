import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { io, Socket } from 'socket.io-client';
import { db, type OutboxItem, type LocalProduct } from './db';
import { BarcodeScanner } from './BarcodeScanner';
import { 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  Package, 
  ArrowUpRight, 
  ArrowDownLeft, 
  Clock, 
  AlertTriangle, 
  CheckCircle2, 
  Server, 
  Database,
  Trash2,
  Camera,
  ScanLine,
  Radio
} from 'lucide-react';

export default function App() {
  const [serverHost, setServerHost] = useState<string>(() => {
    return localStorage.getItem('bodega_api_host') || window.location.hostname || 'localhost';
  });
  const serverPort = '3001';

  const getApiBase = useCallback(() => {
    return `http://${serverHost}:${serverPort}/api`;
  }, [serverHost, serverPort]);

  const [isSimulatedOffline, setIsSimulatedOffline] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(false);
  const [isScannerOpen, setIsScannerOpen] = useState<boolean>(false);
  const [manualBarcode, setManualBarcode] = useState<string>('');
  const [scanActionType, setScanActionType] = useState<'DISPATCH_STOCK' | 'RECEIVE_STOCK'>('RECEIVE_STOCK');

  // IndexedDB Live Queries
  const products = useLiveQuery(() => db.products.toArray(), []) || [];
  const outboxItems = useLiveQuery(() => db.outbox.orderBy('timestamp').reverse().toArray(), []) || [];
  const logs = useLiveQuery(() => db.logs.orderBy('timestamp').reverse().limit(25).toArray(), []) || [];

  const pendingCount = outboxItems.filter(item => item.status === 'PENDING').length;
  const effectiveOnline = isOnline && !isSimulatedOffline;

  const isSyncingRef = useRef(false);
  const socketRef = useRef<Socket | null>(null);

  const addLog = useCallback(async (message: string, type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR') => {
    await db.logs.add({
      timestamp: Date.now(),
      message,
      type
    });
  }, []);

  // Sincronización en tiempo real vía WebSockets (Multidispositivo)
  useEffect(() => {
    if (!effectiveOnline) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        setIsSocketConnected(false);
      }
      return;
    }

    const socketUrl = `http://${serverHost}:${serverPort}`;
    const newSocket = io(socketUrl, {
      reconnectionAttempts: 5,
      timeout: 3000
    });
    socketRef.current = newSocket;

    newSocket.on('connect', () => {
      setIsSocketConnected(true);
      addLog('📡 Conectado a WebSockets (Sincronización multi-dispositivo en tiempo real activa)', 'SUCCESS');
    });

    newSocket.on('disconnect', () => {
      setIsSocketConnected(false);
    });

    // Escuchar cambios de stock emitidos por otros dispositivos
    newSocket.on('stock_updated', async (data: { products: LocalProduct[] }) => {
      if (data.products && data.products.length > 0) {
        await db.products.bulkPut(data.products);
        addLog('🔄 Stock actualizado en tiempo real desde otro dispositivo.', 'INFO');
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, [effectiveOnline, serverHost, serverPort, addLog]);

  // Sincronización de Outbox hacia el Servidor
  const triggerAutoSync = useCallback(async () => {
    if (!effectiveOnline || isSyncingRef.current) return;

    const pendingOps = await db.outbox.where('status').equals('PENDING').toArray();
    if (pendingOps.length === 0) return;

    isSyncingRef.current = true;
    setIsSyncing(true);

    try {
      for (const op of pendingOps) {
        await db.outbox.update(op.id, { status: 'SYNCING' });
      }

      const response = await fetch(`${getApiBase()}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: pendingOps })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.success) {
        for (const res of data.results) {
          if (res.status === 'SUCCESS') {
            await db.outbox.delete(res.outboxId);
          } else {
            await db.outbox.update(res.outboxId, {
              status: 'REJECTED',
              errorMessage: res.reason || 'Rechazado por el servidor'
            });
            await addLog(`Rechazado por servidor: ${res.reason}`, 'ERROR');
          }
        }

        if (data.products && data.products.length > 0) {
          await db.products.bulkPut(data.products);
        }

        await addLog(`⚡ Lote enviado: ${data.results.length} mutaciones sincronizadas.`, 'SUCCESS');
      }
    } catch (err: unknown) {
      for (const op of pendingOps) {
        await db.outbox.update(op.id, { status: 'PENDING' });
      }
      await addLog('Fallo de conexión al enviar mutaciones.', 'WARNING');
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [effectiveOnline, getApiBase, addLog]);

  // Listeners de Red
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      addLog('🌐 Conexión detectada (Online).', 'INFO');
    };
    const handleOffline = () => {
      setIsOnline(false);
      addLog('📴 Sin conexión de red (Offline).', 'WARNING');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const interval = setInterval(() => {
      if (effectiveOnline && pendingCount > 0) {
        triggerAutoSync();
      }
    }, 4000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [effectiveOnline, pendingCount, triggerAutoSync, addLog]);

  useEffect(() => {
    if (effectiveOnline && pendingCount > 0) {
      triggerAutoSync();
    }
  }, [effectiveOnline, pendingCount, triggerAutoSync]);

  const fetchProductsFromServer = async () => {
    try {
      setIsSyncing(true);
      const res = await fetch(`${getApiBase()}/products`);
      const data = await res.json();
      if (data.success) {
        await db.products.clear();
        await db.products.bulkPut(data.data);
        await addLog(`Catálogo cargado (${data.data.length} productos).`, 'SUCCESS');
      }
    } catch (err) {
      await addLog(`No se pudo conectar con ${getApiBase()}`, 'ERROR');
    } finally {
      setIsSyncing(false);
    }
  };

  // Procesar escaneo de código (Existe o Nuevo)
  const handleProcessScan = async (code: string) => {
    if (!code || !code.trim()) return;
    const cleanCode = code.trim().toUpperCase();

    // 1. Buscar en BD Local
    let product = await db.products.where('sku').equalsIgnoreCase(cleanCode).or('id').equalsIgnoreCase(cleanCode).first();
    const action = scanActionType;
    const qty = 1;

    let productName = cleanCode;
    let prodId: string | undefined = undefined;

    if (product) {
      productName = product.name;
      prodId = product.id;
      const newStock = action === 'DISPATCH_STOCK' ? Math.max(0, product.stock - qty) : product.stock + qty;
      await db.products.update(product.id, { stock: newStock });
    } else {
      // 🌟 Si el producto NO existe, lo creamos de inmediato en IndexedDB local
      prodId = `PROD-${Date.now().toString().slice(-4)}`;
      productName = `Prod. Nuevo [${cleanCode}]`;
      const initialStock = action === 'DISPATCH_STOCK' ? 0 : qty;

      const newProd: LocalProduct = {
        id: prodId,
        sku: cleanCode,
        name: productName,
        stock: initialStock,
        price: 10.00,
        updatedAt: new Date().toISOString()
      };
      await db.products.put(newProd);
    }

    // 2. Guardar en Cola Outbox
    const outboxItem: OutboxItem = {
      id: `scan-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      action,
      barcode: cleanCode,
      productId: prodId,
      productName: productName,
      quantity: qty,
      timestamp: Date.now(),
      status: 'PENDING'
    };

    await db.outbox.add(outboxItem);
    await addLog(
      `📷 Escaneado: [${cleanCode}] ${productName} (${action === 'DISPATCH_STOCK' ? '-1 Salida' : '+1 Entrada'})`,
      'INFO'
    );

    setManualBarcode('');

    // Si hay internet, sincronizar de inmediato
    if (effectiveOnline) {
      setTimeout(() => triggerAutoSync(), 50);
    }
  };

  const handleClearLocalDB = async () => {
    if (confirm('¿Deseas vaciar la base de datos local IndexedDB?')) {
      await db.products.clear();
      await db.outbox.clear();
      await db.logs.clear();
      await addLog('Base de datos local reiniciada.', 'INFO');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Modal Cámara */}
      {isScannerOpen && (
        <BarcodeScanner
          onScanSuccess={(decodedText) => handleProcessScan(decodedText)}
          onClose={() => setIsScannerOpen(false)}
        />
      )}

      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-600 rounded-lg text-white shadow-lg shadow-indigo-500/20">
            <ScanLine className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
              Bodega Scan
              <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                PWA / Real-Time Sync
              </span>
            </h1>
            <p className="text-[11px] text-slate-400">Escáner móvil multi-dispositivo</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Socket Indicator */}
          {effectiveOnline && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
              <Radio className={`w-3 h-3 ${isSocketConnected ? 'animate-pulse text-emerald-400' : 'text-slate-500'}`} />
              {isSocketConnected ? 'En Vivo' : 'Conectando WS'}
            </span>
          )}

          {/* Toggle Online/Offline */}
          <button
            onClick={() => setIsSimulatedOffline(!isSimulatedOffline)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition ${
              effectiveOnline
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20'
            }`}
          >
            {effectiveOnline ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span>ONLINE</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-rose-400" />
                <span>OFFLINE {isSimulatedOffline ? '(Simulado)' : ''}</span>
              </>
            )}
          </button>

          {/* Outbox Badge */}
          {pendingCount > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-medium animate-pulse">
              <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{pendingCount} en cola</span>
            </div>
          )}
        </div>
      </header>

      {/* IP Bar */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-400">
          <Server className="w-3.5 h-3.5 text-indigo-400" />
          <span>Servidor API IP:</span>
          <input
            type="text"
            value={serverHost}
            onChange={(e) => {
              setServerHost(e.target.value);
              localStorage.setItem('bodega_api_host', e.target.value);
            }}
            placeholder="IP de tu PC (ej: 192.168.1.3)"
            className="bg-slate-950 border border-slate-700 px-2 py-0.5 rounded text-white text-xs w-36 font-mono focus:border-indigo-500 outline-none"
          />
          <button
            onClick={fetchProductsFromServer}
            disabled={isSyncing}
            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
          >
            Descargar
          </button>
        </div>

        <button
          onClick={handleClearLocalDB}
          className="text-slate-500 hover:text-rose-400 transition flex items-center gap-1 text-[11px]"
        >
          <Trash2 className="w-3 h-3" /> Reiniciar Local DB
        </button>
      </div>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-6xl mx-auto w-full">
        
        {/* Col 1: Escáner y Outbox */}
        <div className="flex flex-col gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Camera className="w-4 h-4 text-indigo-400" />
              Lector de Código de Barras / QR
            </h2>

            <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-lg border border-slate-800">
              <button
                onClick={() => setScanActionType('RECEIVE_STOCK')}
                className={`py-1.5 text-xs font-semibold rounded flex items-center justify-center gap-1.5 transition ${
                  scanActionType === 'RECEIVE_STOCK'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowDownLeft className="w-3.5 h-3.5" /> Entrada (+1)
              </button>
              <button
                onClick={() => setScanActionType('DISPATCH_STOCK')}
                className={`py-1.5 text-xs font-semibold rounded flex items-center justify-center gap-1.5 transition ${
                  scanActionType === 'DISPATCH_STOCK'
                    ? 'bg-rose-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" /> Salida (-1)
              </button>
            </div>

            <button
              onClick={() => setIsScannerOpen(true)}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30 transition active:scale-95"
            >
              <Camera className="w-5 h-5" />
              Abrir Cámara de Celular
            </button>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleProcessScan(manualBarcode);
              }}
              className="flex gap-2 pt-2 border-t border-slate-800"
            >
              <input
                type="text"
                value={manualBarcode}
                onChange={(e) => setManualBarcode(e.target.value)}
                placeholder="Código SKU (ej: 7701234567)"
                className="flex-1 bg-slate-950 border border-slate-700 px-3 py-2 rounded-lg text-xs text-white font-mono focus:border-indigo-500 outline-none"
              />
              <button
                type="submit"
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium transition"
              >
                Registrar
              </button>
            </form>
          </div>

          {/* Outbox */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                Cola de Sincronización (Outbox)
              </h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                {pendingCount} pendientes
              </span>
            </div>

            {outboxItems.length === 0 ? (
              <p className="text-slate-500 text-xs text-center py-4">
                Todo sincronizado con el servidor.
              </p>
            ) : (
              <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                {outboxItems.map((item) => (
                  <div
                    key={item.id}
                    className={`p-2.5 rounded-lg border text-xs flex flex-col gap-1 ${
                      item.status === 'PENDING'
                        ? 'bg-amber-500/5 border-amber-500/30 text-amber-200'
                        : item.status === 'SYNCING'
                        ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-200 animate-pulse'
                        : item.status === 'REJECTED'
                        ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
                        : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="flex justify-between items-center font-medium">
                      <span className="flex items-center gap-1">
                        {item.action === 'DISPATCH_STOCK' ? (
                          <ArrowUpRight className="w-3.5 h-3.5 text-rose-400" />
                        ) : (
                          <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        <span className="font-mono text-slate-200">{item.barcode}</span>
                      </span>
                      <span className="text-[10px] opacity-70">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>

                    <div className="text-slate-400 text-[11px] truncate">
                      {item.productName} ({item.quantity}u)
                    </div>

                    {item.errorMessage && (
                      <div className="mt-1 text-[10px] text-rose-400 flex items-center gap-1 bg-rose-950/50 p-1 rounded">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        <span>{item.errorMessage}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Col 2 & 3: Catálogo Local y Logs */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm flex-1">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Package className="w-4 h-4 text-indigo-400" />
                Catálogo en Vivo (IndexedDB)
              </h2>
              <span className="text-xs text-slate-400">
                {products.length} productos
              </span>
            </div>

            {products.length === 0 ? (
              <div className="text-center py-10 border border-dashed border-slate-800 rounded-lg">
                <Database className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                <p className="text-slate-400 text-xs">No hay catálogo descargado en este dispositivo.</p>
                <button
                  onClick={fetchProductsFromServer}
                  className="mt-3 px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 rounded text-white transition"
                >
                  Descargar Catálogo Inicial
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {products.map((prod) => (
                  <div
                    key={prod.id}
                    onClick={() => handleProcessScan(prod.sku)}
                    className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/80 hover:border-indigo-500/50 cursor-pointer transition flex justify-between items-center group"
                    title="Haz clic para simular escaneo"
                  >
                    <div>
                      <span className="text-[10px] font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                        {prod.sku}
                      </span>
                      <h4 className="font-medium text-slate-200 text-xs mt-1 group-hover:text-indigo-300 transition">
                        {prod.name}
                      </h4>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-bold text-white font-mono">{prod.stock}</span>
                      <span className="text-[10px] text-slate-500 block">unidades</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <h2 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Registro de Actividad y Sincronización
            </h2>
            <div className="flex flex-col gap-1 text-[11px] font-mono max-h-36 overflow-y-auto">
              {logs.map((l) => (
                <div key={l.id} className="flex items-start gap-2">
                  <span className="text-slate-600 select-none">{new Date(l.timestamp).toLocaleTimeString()}</span>
                  <span className={
                    l.type === 'SUCCESS' ? 'text-emerald-400' :
                    l.type === 'ERROR' ? 'text-rose-400' :
                    l.type === 'WARNING' ? 'text-amber-400' : 'text-slate-300'
                  }>
                    {l.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
