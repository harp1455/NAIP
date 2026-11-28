package io.github.harp1455.naip;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.KeyStoreException;
import javax.crypto.AEADBadTagException;
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
    private static final int TAG_BYTES = 16;

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    /** 이미 있는 키. 읽지 못하면 예외 (키 저장소가 잠시 응답하지 않을 때도 여기로 온다) */
    private static SecretKey existingKey(KeyStore ks) throws Exception {
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new KeyStoreException("key entry unavailable");
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }

    /** 쓰기용 키 — 없으면 만든다. 읽기(get)에서는 만들지 않는다 */
    private static SecretKey keyForWrite() throws Exception {
        KeyStore ks = keyStore();
        if (ks.containsAlias(KEY_ALIAS)) return existingKey(ks);
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
                if (!prefs().edit().remove(name).commit()) throw new IllegalStateException("write");
                call.resolve();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keyForWrite());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(sealed, 0, out, iv.length, sealed.length);
            // commit: 디스크에 쓴 뒤에 성공을 돌려준다 (JS는 이것을 보고 예전 평문을 지운다)
            if (!prefs().edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).commit()) {
                throw new IllegalStateException("write");
            }
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
        String stored = prefs().getString(name, null);
        if (stored == null) {
            JSObject result = new JSObject();
            result.put("value", "");
            call.resolve(result);
            return;
        }
        byte[] all;
        try {
            all = Base64.decode(stored, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            forget(call, name); // 저장된 값이 깨졌다
            return;
        }
        if (all.length < IV_BYTES + TAG_BYTES) {
            forget(call, name);
            return;
        }
        try {
            // 키가 없어 보여도 지우지 않는다 — Android 12+ 키 저장소는 일시적인 오류도 "없음"으로 돌려준다.
            // 정말 없어졌다면 사용자가 새 토큰을 넣을 때(set) 새 키로 덮어쓴다
            KeyStore ks = keyStore();
            if (!ks.containsAlias(KEY_ALIAS)) throw new KeyStoreException("key not available");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, existingKey(ks), new GCMParameterSpec(TAG_BYTES * 8, all, 0, IV_BYTES));
            byte[] plain = cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES);
            JSObject result = new JSObject();
            result.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (AEADBadTagException | KeyPermanentlyInvalidatedException e) {
            // 이 키로는 영영 풀 수 없다 (키가 바뀌었거나 값이 손상됐다) — 지우고 비어 있는 것으로 돌려준다
            forget(call, name);
        } catch (Exception e) {
            // 키 저장소가 잠시 응답하지 않는 경우 등 — 값은 그대로 두고 다음 실행에서 다시 읽는다. 메시지에 값을 넣지 않는다
            call.reject("secure store unavailable: " + e.getClass().getSimpleName(), "UNAVAILABLE");
        }
    }

    /** 다시는 읽을 수 없는 값을 지우고 lost로 알린다 */
    private void forget(PluginCall call, String name) {
        prefs().edit().remove(name).commit();
        JSObject result = new JSObject();
        result.put("value", "");
        result.put("lost", true);
        call.resolve(result);
    }
}
