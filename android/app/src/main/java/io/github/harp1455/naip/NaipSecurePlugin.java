package io.github.harp1455.naip;

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

/**
 * 인증정보(NovelAI·GitHub 토큰) 보관소.
 * Android Keystore에 만든 AES-256-GCM 키(기기 밖으로 꺼낼 수 없음)로 암호화해 SharedPreferences에 둔다.
 * 평문은 메모리에서만 다루고 로그에 남기지 않는다. 앱 백업(allowBackup=false)에도 포함되지 않는다.
 */
@CapacitorPlugin(name = "NaipSecure")
public class NaipSecurePlugin extends Plugin {

    private static final String KEY_ALIAS = "naip_secrets_v1";
    private static final String PREFS = "naip_secure";
    private static final int IV_BYTES = 12;

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean validName(String name) {
        return name != null && name.matches("[a-zA-Z0-9_.-]{1,64}");
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("name");
        String value = call.getString("value", "");
        if (!validName(name)) {
            call.reject("invalid name");
            return;
        }
        try {
            if (value.isEmpty()) {
                prefs().edit().remove(name).apply();
                call.resolve();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(sealed, 0, out, iv.length, sealed.length);
            prefs().edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            // 메시지에 값을 넣지 않는다
            call.reject("secure store failed: " + e.getClass().getSimpleName());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("name");
        if (!validName(name)) {
            call.reject("invalid name");
            return;
        }
        JSObject result = new JSObject();
        String stored = prefs().getString(name, null);
        if (stored == null) {
            result.put("value", "");
            call.resolve(result);
            return;
        }
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, IV_BYTES));
            byte[] plain = cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES);
            result.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception e) {
            // 키가 사라졌거나(기기 초기화·잠금 변경 등) 손상된 값 — 지우고 비어 있는 것으로 돌려준다
            prefs().edit().remove(name).apply();
            result.put("value", "");
            result.put("lost", true);
            call.resolve(result);
        }
    }
}
