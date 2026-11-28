package io.github.harp1455.naip;

import java.nio.charset.StandardCharsets;
import java.security.KeyStoreException;
import java.util.Base64;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * NaipSecurePlugin의 암호화·보관 규칙. Android API를 쓰지 않아 데스크톱 JVM에서도 돌린다 (tests/secure-vault.test.ts).
 * 키 저장소와 설정 파일은 Keys·Store로 받는다. 평문과 값은 예외 메시지에 넣지 않는다.
 */
final class SecretVault {

    /** 키 저장소 (휴대폰에서는 AndroidKeyStore) */
    interface Keys {
        /** 없다고 하면 null. Android 12+ 키 저장소는 일시적인 오류도 "없음"으로 답한다. 읽지 못하면 예외 */
        SecretKey find(String alias) throws Exception;
        /** 이 이름으로 새 키를 만든다 (이미 있으면 그 키는 없어지고 새 키로 바뀐다) */
        SecretKey create(String alias) throws Exception;
        void delete(String alias) throws Exception;
        /** 이 키로 다시는 풀 수 없다는 예외인지 (KeyPermanentlyInvalidatedException) */
        boolean isPermanentlyInvalid(Exception e);
    }

    /** 값 보관 (휴대폰에서는 SharedPreferences). put·remove는 디스크에 썼을 때만 true */
    interface Store {
        String get(String name);
        boolean put(String name, String value);
        boolean remove(String name);
    }

    /** 다시는 풀 수 없는 값이라 지웠다 */
    static final class Gone extends Exception {
        Gone() {
            super("stored value can never be decrypted");
        }
    }

    static final String KEY_ALIAS = "naip_secrets_v1";
    private static final int IV_BYTES = 12;
    private static final int TAG_BYTES = 16;

    private final Keys keys;
    private final Store store;

    SecretVault(Keys keys, Store store) {
        this.keys = keys;
        this.store = store;
    }

    /** 빈 값이면 지운다. 디스크에 쓴 뒤에 돌아온다 (실패하면 예외) */
    void set(String name, String value) throws Exception {
        if (value.isEmpty()) {
            if (!store.remove(name)) throw new IllegalStateException("write");
            return;
        }
        SecretKey key = keys.find(KEY_ALIAS);
        if (key == null) key = keys.create(KEY_ALIAS);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        if (!store.put(name, Base64.getEncoder().encodeToString(out))) throw new IllegalStateException("write");
    }

    /**
     * 저장된 값 (없으면 ""). 다시는 풀 수 없는 값(깨졌거나 키가 바뀌었다)이면 지우고 Gone.
     * 그 밖의 실패(키 저장소가 잠시 응답하지 않는 등)는 값을 그대로 두고 예외 — 다음에 다시 읽는다
     */
    String get(String name) throws Exception {
        String stored = store.get(name);
        if (stored == null) return "";
        byte[] all;
        try {
            all = Base64.getDecoder().decode(stored);
        } catch (IllegalArgumentException e) {
            throw forget(name);
        }
        if (all.length < IV_BYTES + TAG_BYTES) throw forget(name);
        // 키가 없어 보여도 지우지 않는다 — 일시적인 오류일 수 있다
        SecretKey key = keys.find(KEY_ALIAS);
        if (key == null) throw new KeyStoreException("key not available");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BYTES * 8, all, 0, IV_BYTES));
            return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (AEADBadTagException e) {
            throw forget(name);
        } catch (Exception e) {
            if (keys.isPermanentlyInvalid(e)) throw forget(name);
            throw e;
        }
    }

    private Gone forget(String name) {
        store.remove(name);
        return new Gone();
    }
}
