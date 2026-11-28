package io.github.harp1455.naip;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import java.security.KeyStoreException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * 인증정보(NovelAI·GitHub 토큰) 보관소.
 * Android Keystore에 만든 AES-256-GCM 키(기기 밖으로 꺼낼 수 없음)로 암호화해 SharedPreferences에 둔다.
 * 평문은 메모리에서만 다루고 로그에 남기지 않는다. 앱 백업(allowBackup=false)에도 포함되지 않는다.
 * 암호화·보관 규칙은 SecretVault에 있다.
 */
@CapacitorPlugin(name = "NaipSecure")
public class NaipSecurePlugin extends Plugin {

    private static final String PREFS = "naip_secure";

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private static final SecretVault.Keys KEYS = new SecretVault.Keys() {
        @Override
        public SecretKey find(String alias) throws Exception {
            KeyStore ks = keyStore();
            if (!ks.containsAlias(alias)) return null;
            // 읽지 못하면 예외 (키 저장소가 잠시 응답하지 않을 때도 여기로 온다)
            KeyStore.Entry entry = ks.getEntry(alias, null);
            if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new KeyStoreException("key entry unavailable");
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }

        @Override
        public SecretKey create(String alias) throws Exception {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(
                new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            return gen.generateKey();
        }

        @Override
        public void delete(String alias) throws Exception {
            keyStore().deleteEntry(alias);
        }

        @Override
        public boolean isPermanentlyInvalid(Exception e) {
            return e instanceof KeyPermanentlyInvalidatedException;
        }
    };

    private SecretVault vault() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new SecretVault(
            KEYS,
            new SecretVault.Store() {
                @Override
                public String get(String name) {
                    return prefs.getString(name, null);
                }

                // commit: 디스크에 쓴 뒤에 성공을 돌려준다 (JS는 이것을 보고 예전 평문을 지운다)
                @Override
                public boolean put(String name, String value) {
                    return prefs.edit().putString(name, value).commit();
                }

                @Override
                public boolean remove(String name) {
                    return prefs.edit().remove(name).commit();
                }
            }
        );
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
            vault().set(name, value);
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
        try {
            result.put("value", vault().get(name));
        } catch (SecretVault.Gone e) {
            // 이 키로는 영영 풀 수 없어 지웠다 (키가 바뀌었거나 값이 손상됐다) — 비어 있는 것으로 돌려준다
            result.put("value", "");
            result.put("lost", true);
        } catch (Exception e) {
            // 키 저장소가 잠시 응답하지 않는 경우 등 — 값은 그대로 두고 다음 실행에서 다시 읽는다. 메시지에 값을 넣지 않는다
            call.reject("secure store unavailable: " + e.getClass().getSimpleName(), "UNAVAILABLE");
            return;
        }
        call.resolve(result);
    }
}
