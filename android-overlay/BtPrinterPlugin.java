package com.px.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.util.UUID;

/** Prints raw ESC/POS bytes to a paired Bluetooth Classic (SPP) thermal printer. */
@CapacitorPlugin(
    name = "BtPrinter",
    permissions = { @Permission(alias = "bt", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class BtPrinterPlugin extends Plugin {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private BluetoothSocket socket;
    private String socketAddr;

    private boolean needsPermission(PluginCall call, String callback) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bt") != PermissionState.GRANTED) {
            requestPermissionForAlias("bt", call, callback);
            return true;
        }
        return false;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsPermission(call, "listCallback")) return;
        doList(call);
    }

    @PermissionCallback
    private void listCallback(PluginCall call) {
        if (getPermissionState("bt") == PermissionState.GRANTED) doList(call);
        else call.reject("Izin Bluetooth ditolak");
    }

    private void doList(PluginCall call) {
        BluetoothAdapter a = adapter();
        if (a == null) { call.reject("Perangkat ini tidak punya Bluetooth"); return; }
        if (!a.isEnabled()) { call.reject("Bluetooth mati — nyalakan dulu"); return; }
        try {
            JSArray arr = new JSArray();
            for (BluetoothDevice d : a.getBondedDevices()) {
                JSObject o = new JSObject();
                o.put("name", d.getName());
                o.put("address", d.getAddress());
                arr.put(o);
            }
            JSObject r = new JSObject();
            r.put("devices", arr);
            call.resolve(r);
        } catch (SecurityException e) {
            call.reject("Izin Bluetooth ditolak");
        }
    }

    @PluginMethod
    public void print(PluginCall call) {
        if (needsPermission(call, "printCallback")) return;
        doPrint(call);
    }

    @PermissionCallback
    private void printCallback(PluginCall call) {
        if (getPermissionState("bt") == PermissionState.GRANTED) doPrint(call);
        else call.reject("Izin Bluetooth ditolak");
    }

    private void doPrint(final PluginCall call) {
        final String addr = call.getString("address");
        final String data = call.getString("data");
        if (addr == null || data == null) { call.reject("address dan data wajib diisi"); return; }
        final byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        new Thread(() -> {
            try {
                write(addr, bytes);
                call.resolve();
            } catch (Exception first) {
                closeSocket(); // stale connection → reconnect once
                try {
                    write(addr, bytes);
                    call.resolve();
                } catch (Exception e) {
                    closeSocket();
                    call.reject("Gagal print: " + e.getMessage() + ". Pastikan printer nyala & sudah di-pair.");
                }
            }
        }).start();
    }

    private synchronized void write(String addr, byte[] bytes) throws Exception {
        if (socket == null || !socket.isConnected() || !addr.equals(socketAddr)) {
            closeSocket();
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) throw new Exception("Bluetooth mati");
            try { a.cancelDiscovery(); } catch (SecurityException ignored) { }
            BluetoothDevice d = a.getRemoteDevice(addr);
            BluetoothSocket s;
            try {
                s = d.createRfcommSocketToServiceRecord(SPP);
                s.connect();
            } catch (Exception e) {
                s = d.createInsecureRfcommSocketToServiceRecord(SPP);
                s.connect();
            }
            socket = s;
            socketAddr = addr;
        }
        OutputStream os = socket.getOutputStream();
        for (int i = 0; i < bytes.length; i += 512) {
            os.write(bytes, i, Math.min(512, bytes.length - i));
            os.flush();
            Thread.sleep(15);
        }
    }

    private synchronized void closeSocket() {
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null;
        socketAddr = null;
    }

    @Override
    protected void handleOnDestroy() {
        closeSocket();
    }
}
