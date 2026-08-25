import Dexie, { type Table } from 'dexie';

export interface LocalProduct {
  id: string;
  name: string;
  sku: string; // Código de barra / QR
  stock: number;
  price: number;
  updatedAt: string;
}

export interface OutboxItem {
  id: string;
  action: 'SCAN_INVENTORY' | 'DISPATCH_STOCK' | 'RECEIVE_STOCK';
  barcode: string;
  productId?: string;
  productName?: string;
  quantity: number;
  timestamp: number;
  status: 'PENDING' | 'SYNCING' | 'SUCCESS' | 'REJECTED';
  errorMessage?: string;
}

export interface SyncLog {
  id?: number;
  timestamp: number;
  message: string;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
}

export class BodegaDatabase extends Dexie {
  products!: Table<LocalProduct, string>;
  outbox!: Table<OutboxItem, string>;
  logs!: Table<SyncLog, number>;

  constructor() {
    super('BodegaOfflineDB');
    this.version(2).stores({
      products: 'id, sku, name',
      outbox: 'id, action, barcode, productId, status, timestamp',
      logs: '++id, timestamp, type'
    });
  }
}

export const db = new BodegaDatabase();
