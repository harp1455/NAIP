package io.github.harp1455.naip;

import java.nio.charset.StandardCharsets;
import java.security.KeyStoreException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * NaipSecurePlugin의 암호화·보관 규칙. Android API를 쓰지 않아 데스크톱 JVM에서도 돌린다 (tests/secure-vault.test.ts).
 * 키 저장소와 설정 파일은 Keys·Store로 받는다. 평문과 값은 예외 메시지에 넣지 않는다.
 *
 * 값마다 자기 키를 쓰고, 저장한 값에 그 키 이름을 같이 적는다: "2:<키 이름>:<Base64(IV + 암호문)>".
 * 키는 바꾸지 않는다 — 새 키는 늘 처음 쓰는 이름으로 만들고, 예전 키는 그 키로 잠근 값을 디스크에서 덮어쓴 뒤에만 지운다.
 * Android 12+ 키 저장소는 일시적인 오류에도 "키 없음"이라고 답하는데, 그때 같은 이름으로 키를 새로 만들면
 * 예전 키가 없어져 그 키로 잠근 값(다른 토큰까지)을 다시는 풀 수 없게 된다.
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

    /** 예전 형식: 모든 이름이 같이 쓰던 키, 값은 Base64(IV + 암호문)만. 읽기만 하고 다시 만들거나 바꾸지 않는다 */
    static final String LEGACY_ALIAS = "naip_secrets_v1";
    private static final String FORMAT = "2:";
    private static final String ALIAS_PREFIX = "naip_secret.";
    private static final int ID_HEX = 16;
    private static final int IV_BYTES = 12;
    private static final int TAG_BYTES = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Keys keys;
    private final Store store;

    SecretVault(Keys keys, Store store) {
        this.keys = keys;
        this.store = store;
    }

    /** 저장된 값이 가리키는 키와 암호문 */
    private static final class Sealed {
        final String alias;
        final String body;

        Sealed(String alias, String body) {
            this.alias = alias;
            this.body = body;
        }
    }

    /** 알아볼 수 없는 형식이면 null */
    private static Sealed parse(String name, String stored) {
        if (!stored.startsWith(FORMAT)) return new Sealed(LEGACY_ALIAS, stored); // Base64에는 ':'가 없다
        int split = stored.indexOf(':', FORMAT.length());
        if (split < 0) return null;
        String alias = stored.substring(FORMAT.length(), split);
        String own = ALIAS_PREFIX + name + ".";
        if (!alias.startsWith(own) || !alias.substring(own.length()).matches("[0-9a-f]{" + ID_HEX + "}")) return null;
        return new Sealed(alias, stored.substring(split + 1));
    }

    /** 이 이름의 값이 쓰는 자기 키 (예전 형식이거나 값이 없으면 null — 같이 쓰던 키는 지우지 않는다) */
    private static String ownAlias(String name, String stored) {
        if (stored == null) return null;
        Sealed s = parse(name, stored);
        return s == null || s.alias.equals(LEGACY_ALIAS) ? null : s.alias;
    }

    /** 처음 쓰는 키 이름: naip_secret.<이름>.<무작위 16자리 16진수> */
    private static String freshAlias(String name) {
        byte[] id = new byte[ID_HEX / 2];
        RANDOM.nextBytes(id);
        StringBuilder alias = new StringBuilder(ALIAS_PREFIX).append(name).append('.');
        for (byte b : id) alias.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return alias.toString();
    }

    /** 지금 값이 더는 쓰지 않는 키를 지운다. 실패해도 괜찮다 (쓰지 않는 키가 남을 뿐) */
    private void dropUnused(String alias) {
        if (alias == null) return;
        try {
            keys.delete(alias);
        } catch (Exception ignored) {
            // 다음에 지우지 못해도 값에는 영향이 없다
        }
    }

    /** 빈 값이면 지운다. 디스크에 쓴 뒤에 돌아온다 (실패하면 예외) */
    void set(String name, String value) throws Exception {
        String previous = ownAlias(name, store.get(name));
        if (value.isEmpty()) {
            if (!store.remove(name)) throw new IllegalStateException("write");
            dropUnused(previous);
            return;
        }
        String alias = previous;
        byte[] out = null;
        if (previous != null) {
            try {
                SecretKey key = keys.find(previous);
                if (key != null) out = seal(key, value);
            } catch (Exception e) {
                // 예전 키가 목록에는 있는데 쓸 수 없다 (키 덩어리가 깨졌거나 잠시 응답하지 않는다) — 아래에서 새 키로 잠근다.
                // 그 키를 계속 다시 쓰면 새 토큰을 영영 저장하지 못한다 (깨진 키는 영구 무효로 알려지지 않을 수 있다)
            }
        }
        if (out == null) {
            // 키가 정말 없거나, 잠시 "없음"으로 보이거나, 쓸 수 없다 — 어느 쪽이든 예전 키는 그대로 두고 새 이름으로 만든다
            alias = freshAlias(name);
            SecretKey key = keys.create(alias);
            try {
                out = seal(key, value);
            } catch (Exception e) {
                dropUnused(alias); // 처음 쓰는 이름이라 이 키로 잠근 값은 어디에도 없다
                throw e;
            }
        }
        // 디스크에 못 써도 키는 지우지 않는다 — SharedPreferences는 메모리에는 이미 넣었고 다음 commit이 디스크에 쓴다
        if (!store.put(name, FORMAT + alias + ":" + Base64.getEncoder().encodeToString(out))) {
            throw new IllegalStateException("write");
        }
        if (!alias.equals(previous)) dropUnused(previous);
    }

    /** IV + 암호문 */
    private static byte[] seal(SecretKey key, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        return out;
    }

    /**
     * 저장된 값 (없으면 ""). 다시는 풀 수 없는 값(깨졌거나 키가 바뀌었다)이면 지우고 Gone.
     * 그 밖의 실패(키 저장소가 잠시 응답하지 않는 등)는 값을 그대로 두고 예외 — 다음에 다시 읽는다
     */
    String get(String name) throws Exception {
        String stored = store.get(name);
        if (stored == null) return "";
        Sealed s = parse(name, stored);
        if (s == null) throw forget(name);
        byte[] all;
        try {
            all = Base64.getDecoder().decode(s.body);
        } catch (IllegalArgumentException e) {
            throw forget(name);
        }
        if (all.length < IV_BYTES + TAG_BYTES) throw forget(name);
        // 키가 없어 보이거나 쓸 수 없어도 지우지 않는다 — 일시적인 오류일 수 있다. 정말 없어졌거나 깨졌다면 사용자가 새 토큰을 넣을 때(set) 새 키로 덮어쓴다
        SecretKey key = keys.find(s.alias);
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

    /** 다시는 읽을 수 없는 값을 지운다 (그 값의 자기 키도 — 같이 쓰던 키는 다른 값이 쓸 수 있어 두고) */
    private Gone forget(String name) {
        String alias = ownAlias(name, store.get(name));
        if (store.remove(name)) dropUnused(alias);
        return new Gone();
    }
}
