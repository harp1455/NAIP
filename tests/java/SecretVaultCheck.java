package io.github.harp1455.naip;

import java.nio.charset.StandardCharsets;
import java.security.KeyStoreException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

/**
 * SecretVault를 데스크톱 JVM에서 돌려 본다 (tests/secure-vault.test.ts가 javac로 빌드해 시나리오 하나씩 실행).
 * 키 저장소는 AndroidKeyStore처럼 흉내 낸다: 같은 이름으로 키를 만들면 예전 키는 없어지고,
 * Android 12+처럼 일시적인 오류에도 "없음"이라고 답할 수 있다. 설정 파일은 SharedPreferences처럼
 * 메모리와 디스크가 따로다 (commit이 디스크에 실패해도 메모리에는 들어가고, 다음 commit이 통째로 디스크에 쓴다).
 * 실패하면 이유를 찍고 1로 끝난다.
 */
public final class SecretVaultCheck {

    static final SecureRandom RANDOM = new SecureRandom();

    static final class FakeKeys implements SecretVault.Keys {
        final Map<String, SecretKey> keys = new HashMap<>();
        /** containsAlias가 모든 이름을 "없음"으로 답한다 (일시적인 오류) */
        boolean reportMissing;
        /** 키 저장소 호출이 모두 실패한다 */
        boolean failing;
        /** 이미 있는 키를 새 키로 바꾼 횟수 (그 키로 잠근 값은 다시는 풀 수 없다) */
        int replaced;

        @Override
        public SecretKey find(String alias) throws Exception {
            if (failing) throw new KeyStoreException("system error");
            if (reportMissing) return null;
            return keys.get(alias);
        }

        @Override
        public SecretKey create(String alias) throws Exception {
            if (failing) throw new KeyStoreException("system error");
            byte[] raw = new byte[32];
            RANDOM.nextBytes(raw);
            SecretKey key = new SecretKeySpec(raw, "AES");
            if (keys.put(alias, key) != null) replaced++;
            return key;
        }

        @Override
        public void delete(String alias) throws Exception {
            if (failing) throw new KeyStoreException("system error");
            keys.remove(alias);
        }

        @Override
        public boolean isPermanentlyInvalid(Exception e) {
            return false;
        }
    }

    static final class FakePrefs implements SecretVault.Store {
        Map<String, String> memory = new HashMap<>();
        Map<String, String> disk = new HashMap<>();
        /** 디스크 쓰기가 실패한다 */
        boolean diskFails;

        @Override
        public String get(String name) {
            return memory.get(name);
        }

        @Override
        public boolean put(String name, String value) {
            memory.put(name, value);
            return flush();
        }

        @Override
        public boolean remove(String name) {
            memory.remove(name);
            return flush();
        }

        private boolean flush() {
            if (diskFails) return false;
            disk = new HashMap<>(memory);
            return true;
        }

        /** 앱을 다시 연다 — 디스크에 있는 것만 남는다 */
        void relaunch() {
            memory = new HashMap<>(disk);
        }
    }

    final FakeKeys keys = new FakeKeys();
    final FakePrefs prefs = new FakePrefs();
    final SecretVault vault = new SecretVault(keys, prefs);

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    /** 값을 읽는다. 다시는 못 읽게 됐거나 읽지 못하면 그 사실을 문자열로 돌려준다 (비교용) */
    String read(String name) {
        try {
            return vault.get(name);
        } catch (SecretVault.Gone e) {
            return "<lost>";
        } catch (Exception e) {
            return "<unavailable>";
        }
    }

    /** 한 번 읽어 기대한 값인지 본다 (읽기가 값을 지울 수 있어 두 번 읽지 않는다) */
    void expectRead(String name, String want, String what) {
        String got = read(name);
        check(got.equals(want), what + ": expected " + (want.isEmpty() ? "<empty>" : want) + ", got " + (got.isEmpty() ? "<empty>" : got));
    }

    boolean setFails(String name, String value) {
        try {
            vault.set(name, value);
            return false;
        } catch (Exception e) {
            return true;
        }
    }

    /** 이전 버전이 남긴 값: 모든 이름이 같이 쓰는 키(naip_secrets_v1)로 잠그고 IV+암호문을 Base64로 */
    void storeLegacy(String name, String value) throws Exception {
        SecretKey key = keys.keys.get("naip_secrets_v1");
        if (key == null) key = keys.create("naip_secrets_v1");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        prefs.put(name, Base64.getEncoder().encodeToString(out));
    }

    /** 한 토큰을 쓰는 동안 키가 "없음"으로 보여도 다른 토큰은 그대로 읽힌다 */
    void otherTokenSurvivesFalseMissingOnWrite() throws Exception {
        vault.set("naiToken", "pst-nai");
        vault.set("githubToken", "ghp-one");
        keys.reportMissing = true;
        vault.set("githubToken", "ghp-two");
        keys.reportMissing = false;
        prefs.relaunch();
        expectRead("naiToken", "pst-nai", "naiToken after a GitHub token write that saw no key");
        expectRead("githubToken", "ghp-two", "githubToken");
        check(keys.replaced == 0, "a key in use was replaced " + keys.replaced + " time(s)");
        // 새 키를 만들었으면 덮어쓴 값의 예전 키는 지운다 (토큰마다 키 하나)
        check(keys.keys.size() == 2, "keys left: " + keys.keys.keySet());
    }

    /** 이전 버전이 같이 쓰는 키로 잠근 값도 읽히고, 다른 토큰을 써도 그 키는 바뀌지 않는다 */
    void legacySharedKeyValuesStayReadable() throws Exception {
        storeLegacy("naiToken", "pst-old");
        storeLegacy("githubToken", "ghp-old");
        expectRead("naiToken", "pst-old", "legacy naiToken");
        expectRead("githubToken", "ghp-old", "legacy githubToken");
        keys.reportMissing = true;
        vault.set("githubToken", "ghp-new");
        keys.reportMissing = false;
        prefs.relaunch();
        expectRead("naiToken", "pst-old", "legacy naiToken after a GitHub token write");
        expectRead("githubToken", "ghp-new", "githubToken");
        vault.set("githubToken", "ghp-newer");
        expectRead("naiToken", "pst-old", "legacy naiToken after a normal write");
        check(keys.replaced == 0, "a key in use was replaced " + keys.replaced + " time(s)");
    }

    /** 새 키를 만들고 디스크 쓰기가 실패해도, 디스크에 남은 예전 값은 그 키로 계속 풀린다 */
    void failedWriteAfterFalseMissingKeepsOldValue() throws Exception {
        vault.set("naiToken", "pst-old");
        keys.reportMissing = true;
        prefs.diskFails = true;
        check(setFails("naiToken", "pst-new"), "a write that did not reach the disk resolved");
        keys.reportMissing = false;
        prefs.diskFails = false;
        prefs.relaunch();
        expectRead("naiToken", "pst-old", "naiToken after a failed write");
        check(keys.replaced == 0, "a key in use was replaced " + keys.replaced + " time(s)");
    }

    /** 디스크에 못 쓴 값이 메모리에 남아 다음 commit에 디스크로 가도 풀린다 (그 키를 지우지 않는다) */
    void failedWriteThatLaterReachesDiskStaysReadable() throws Exception {
        vault.set("naiToken", "pst-old");
        keys.reportMissing = true;
        prefs.diskFails = true;
        check(setFails("naiToken", "pst-new"), "a write that did not reach the disk resolved");
        keys.reportMissing = false;
        prefs.diskFails = false;
        vault.set("githubToken", "ghp-one"); // SharedPreferences는 메모리 내용을 통째로 디스크에 쓴다
        prefs.relaunch();
        expectRead("naiToken", "pst-new", "naiToken written by a later commit");
        expectRead("githubToken", "ghp-one", "githubToken");
    }

    /** 키 저장소가 응답하지 않으면 읽기·쓰기 모두 실패로 알리고 값은 지우지 않는다 */
    void keystoreErrorsNeverDelete() throws Exception {
        vault.set("naiToken", "pst-nai");
        keys.failing = true;
        expectRead("naiToken", "<unavailable>", "read while the key store fails");
        check(setFails("naiToken", "pst-other"), "a write while the key store fails resolved");
        keys.failing = false;
        prefs.relaunch();
        expectRead("naiToken", "pst-nai", "naiToken after key store errors");
        keys.reportMissing = true;
        expectRead("naiToken", "<unavailable>", "read while the key looks missing");
        keys.reportMissing = false;
        expectRead("naiToken", "pst-nai", "naiToken after the key looked missing");
    }

    /** 다시는 풀 수 없는 값(암호문이 바뀌었거나 깨졌다)만 지우고 lost로 알린다 */
    void undecryptableValuesAreForgotten() throws Exception {
        vault.set("naiToken", "pst-nai");
        String stored = prefs.get("naiToken");
        char last = stored.charAt(stored.length() - 3);
        prefs.put("naiToken", stored.substring(0, stored.length() - 3) + (last == 'A' ? 'B' : 'A') + stored.substring(stored.length() - 2));
        expectRead("naiToken", "<lost>", "tampered value");
        check(prefs.get("naiToken") == null, "tampered value was kept");
        expectRead("naiToken", "", "after forgetting");
        prefs.put("githubToken", "%%%");
        expectRead("githubToken", "<lost>", "corrupt Base64");
        prefs.put("githubToken", "AAAA");
        expectRead("githubToken", "<lost>", "too short");
        prefs.put("githubToken", "2:naip_secrets_v1:AAAA");
        expectRead("githubToken", "<lost>", "a new-format value that names a key it does not own");
    }

    /** 빈 값은 지우기, 한글 값도 그대로 */
    void clearAndRoundTrip() throws Exception {
        vault.set("naiToken", "토큰-값");
        check(!prefs.get("naiToken").contains("토큰"), "plaintext in the stored value");
        String stored = prefs.get("naiToken");
        check(stored.startsWith("2:naip_secret.naiToken."), "stored format: " + stored.substring(0, Math.max(0, stored.lastIndexOf(':'))));
        expectRead("naiToken", "토큰-값", "round trip");
        vault.set("naiToken", "");
        check(prefs.get("naiToken") == null, "cleared value was kept");
        expectRead("naiToken", "", "after clearing");
        check(keys.keys.isEmpty(), "keys left after clearing: " + keys.keys.keySet());
        vault.set("naiToken", "pst-again");
        prefs.relaunch();
        expectRead("naiToken", "pst-again", "after setting again");
    }

    public static void main(String[] args) throws Exception {
        SecretVaultCheck t = new SecretVaultCheck();
        try {
            switch (args[0]) {
                case "otherTokenSurvivesFalseMissingOnWrite": t.otherTokenSurvivesFalseMissingOnWrite(); break;
                case "legacySharedKeyValuesStayReadable": t.legacySharedKeyValuesStayReadable(); break;
                case "failedWriteAfterFalseMissingKeepsOldValue": t.failedWriteAfterFalseMissingKeepsOldValue(); break;
                case "failedWriteThatLaterReachesDiskStaysReadable": t.failedWriteThatLaterReachesDiskStaysReadable(); break;
                case "keystoreErrorsNeverDelete": t.keystoreErrorsNeverDelete(); break;
                case "undecryptableValuesAreForgotten": t.undecryptableValuesAreForgotten(); break;
                case "clearAndRoundTrip": t.clearAndRoundTrip(); break;
                default: throw new AssertionError("unknown scenario " + args[0]);
            }
        } catch (AssertionError e) {
            System.out.println("FAIL " + args[0] + ": " + e.getMessage());
            System.exit(1);
        }
        System.out.println("ok " + args[0]);
    }
}
