#!/usr/bin/env python3
"""Patch the generated Capacitor android/ project: Bluetooth printer plugin, permissions, signing, version."""
import os, re, shutil, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(root, "android")
java = os.path.join(A, "app/src/main/java/com/px/pos")
for f in ("MainActivity.java", "BtPrinterPlugin.java"):
    shutil.copy(os.path.join(root, "android-overlay", f), os.path.join(java, f))

mf = os.path.join(A, "app/src/main/AndroidManifest.xml")
s = open(mf).read()
perms = """
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-feature android:name="android.hardware.bluetooth" android:required="false" />
    <queries>
        <package android:name="ru.a402d.rawbtprinter" />
        <package android:name="com.whatsapp" />
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="rawbt" /></intent>
    </queries>
"""
if "BLUETOOTH_CONNECT" not in s:
    s = s.replace('<uses-permission android:name="android.permission.INTERNET" />', '<uses-permission android:name="android.permission.INTERNET" />' + perms)
open(mf, "w").write(s)

bg = os.path.join(A, "app/build.gradle")
g = open(bg).read()
code = os.environ.get("VERSION_CODE", "1"); name = os.environ.get("VERSION_NAME", "1.0.0")
g = re.sub(r"versionCode \d+", f"versionCode {int(code)}", g)
g = re.sub(r'versionName "[^"]*"', f'versionName "{name}"', g)
if "signingConfigs" not in g:
    g = g.replace("    buildTypes {", """    signingConfigs {
        release {
            if (System.getenv("PX_KEYSTORE")) {
                storeFile file(System.getenv("PX_KEYSTORE"))
                storePassword System.getenv("PX_KEYSTORE_PASSWORD")
                keyAlias System.getenv("PX_KEY_ALIAS")
                keyPassword System.getenv("PX_KEY_PASSWORD")
            }
        }
    }
    buildTypes {""", 1)
    g = g.replace("            minifyEnabled false", "            minifyEnabled false\n            if (System.getenv(\"PX_KEYSTORE\")) signingConfig signingConfigs.release", 1)
open(bg, "w").write(g)
print("android project patched: version", code, name)
