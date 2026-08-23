package com.justinivancic.orbital;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureSession")
public class SecureSessionPlugin extends Plugin {
    private static final String KEY_ALIAS = "orbital_mobile_session_key";
    private static final String PREFS_NAME = "orbital_secure_session";
    private static final String TOKEN_KEY = "access_token";

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);

        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore"
        );
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());

        return generator.generateKey();
    }

    private String encrypt(String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        byte[] payload = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, payload, 0, iv.length);
        System.arraycopy(ciphertext, 0, payload, iv.length, ciphertext.length);
        return Base64.encodeToString(payload, Base64.NO_WRAP);
    }

    private String decrypt(String value) throws Exception {
        byte[] payload = Base64.decode(value, Base64.NO_WRAP);
        if (payload.length <= 12) {
            throw new IllegalArgumentException("Invalid encrypted session.");
        }

        byte[] iv = new byte[12];
        byte[] ciphertext = new byte[payload.length - iv.length];
        System.arraycopy(payload, 0, iv, 0, iv.length);
        System.arraycopy(payload, iv.length, ciphertext, 0, ciphertext.length);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.isEmpty()) {
            call.reject("A session token is required.");
            return;
        }

        try {
            preferences().edit().putString(TOKEN_KEY, encrypt(token)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not protect the mobile session.", error);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String encrypted = preferences().getString(TOKEN_KEY, null);
        if (encrypted == null) {
            JSObject result = new JSObject();
            result.put("token", (String) null);
            call.resolve(result);
            return;
        }

        try {
            JSObject result = new JSObject();
            result.put("token", decrypt(encrypted));
            call.resolve(result);
        } catch (Exception error) {
            preferences().edit().remove(TOKEN_KEY).apply();
            call.reject("Could not read the protected mobile session.", error);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        preferences().edit().remove(TOKEN_KEY).apply();
        call.resolve();
    }
}
