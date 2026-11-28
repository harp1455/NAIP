package io.github.harp1455.naip;

import java.nio.charset.StandardCharsets;
import java.security.KeyStoreException;
import java.security.SecureRandom;
import java.security.UnrecoverableKeyException;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
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
        /** 이 이름들은 목록에는 있는데 꺼내지 못한다 (getEntry가 예외) */
        final Set<String> unreadable = new HashSet<>();
        /** 새로 만든 키로도 암호화하지 못한다 */
        boolean createUnusable;
        /** 이미 있는 키를 새 키로 바꾼 횟수 (그 키로 잠근 값은 다시는 풀 수 없다) */
        int replaced;

        @Override
        public SecretKey find(String alias) throws Exception {
            if (failing) throw new KeyStoreException("system error");
            if (reportMissing) return null;
            if (unreadable.contains(alias)) throw new UnrecoverableKeyException("entry unreadable");
            return keys.get(alias);
        }

        @Override
        public SecretKey create(String alias) throws Exception {
            if (failing) throw new KeyStoreException("system error");
            SecretKey key = createUnusable ? unusableKey() : new SecretKeySpec(randomBytes(32), "AES");
            if (keys.put(alias, key) != null) replaced++;
            return key;
        }

        /** 목록에는 있지만 쓰면 늘 InvalidKeyException인 키 (키 저장소의 키 덩어리가 깨졌을 때처럼 — 영구 무효로는 알리지 않는다) */
        void breakKey(String alias) {
            check(keys.containsKey(alias), "no key " + alias);
            keys.put(alias, unusableKey());
        }

        static SecretKey unusableKey() {
            return new SecretKeySpec(randomBytes(5), "AES");
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

    static byte[] randomBytes(int n) {
        byte[] raw = new byte[n];
        RANDOM.nextBytes(raw);
        return raw;
    }

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

    /** 저장된 값이 가리키는 키 이름 ("2:<키 이름>:<암호문>") */
    String aliasOf(String name) {
        String stored = prefs.get(name);
        return stored.substring(2, stored.indexOf(':', 2));
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

    /** 키가 목록에는 있는데 쓸 수 없으면 읽기는 지우지 않고 실패하고, 새 값을 넣을 때는 새 키로 잠근다 */
    void unusableKeyIsReplacedOnWrite() throws Exception {
        vault.set("naiToken", "pst-old");
        vault.set("githubToken", "ghp-one");
        String broken = aliasOf("naiToken");
        keys.breakKey(broken);
        expectRead("naiToken", "<unavailable>", "read with an unusable key");
        check(prefs.get("naiToken") != null, "value deleted after a read with an unusable key");
        // 안내대로 토큰을 다시 넣는다 — 지우기("")를 거치지 않아도 저장돼야 한다 (NovelAI 칸은 빈 값을 저장할 수 없다)
        check(!setFails("naiToken", "pst-new"), "a new token could not be saved over a value whose key is unusable");
        prefs.relaunch();
        expectRead("naiToken", "pst-new", "naiToken after re-entering it");
        expectRead("githubToken", "ghp-one", "githubToken after the NovelAI token got a new key");
        check(!aliasOf("naiToken").equals(broken), "the new value is sealed with the unusable key");
        check(!keys.keys.containsKey(broken), "the unusable key was kept after the new value reached the disk");
        check(keys.keys.size() == 2, "keys left: " + keys.keys.keySet());
        check(keys.replaced == 0, "a key in use was replaced " + keys.replaced + " time(s)");
    }

    /** 키를 꺼내지 못해도(getEntry 예외) 새 값은 새 키로 저장된다 */
    void unreadableKeyIsReplacedOnWrite() throws Exception {
        vault.set("naiToken", "pst-old");
        vault.set("githubToken", "ghp-one");
        String stuck = aliasOf("naiToken");
        keys.unreadable.add(stuck);
        expectRead("naiToken", "<unavailable>", "read with an unreadable key");
        check(!setFails("naiToken", "pst-new"), "a new token could not be saved over a value whose key cannot be read");
        prefs.relaunch();
        expectRead("naiToken", "pst-new", "naiToken after re-entering it");
        expectRead("githubToken", "ghp-one", "githubToken");
        check(!keys.keys.containsKey(stuck), "the unreadable key was kept after the new value reached the disk");
        check(keys.replaced == 0, "a key in use was replaced " + keys.replaced + " time(s)");
    }

    /** 쓸 수 없는 키를 새 키로 바꾸다 디스크 쓰기가 실패하면 예전 키도 새 키도 지우지 않는다 (다음 commit이 새 값을 쓸 수 있다) */
    void failedWriteOverUnusableKeyKeepsBothKeys() throws Exception {
        vault.set("naiToken", "pst-old");
        String broken = aliasOf("naiToken");
        keys.breakKey(broken);
        prefs.diskFails = true;
        check(setFails("naiToken", "pst-new"), "a write that did not reach the disk resolved");
        prefs.diskFails = false;
        check(keys.keys.containsKey(broken), "the old key was deleted although the new value never reached the disk");
        String fresh = aliasOf("naiToken"); // SharedPreferences 메모리에는 새 값이 들어 있다
        check(!fresh.equals(broken) && keys.keys.containsKey(fresh), "the key of the value in memory is missing");
        vault.set("githubToken", "ghp-one"); // 다음 commit이 메모리 내용을 통째로 디스크에 쓴다
        prefs.relaunch();
        expectRead("naiToken", "pst-new", "naiToken written by a later commit");
    }

    /** 새로 만든 키로도 잠그지 못하면 실패로 알리고, 아무 값도 가리키지 않는 그 키는 남기지 않는다 */
    void freshKeyThatCannotSealIsDropped() throws Exception {
        vault.set("naiToken", "pst-old");
        String broken = aliasOf("naiToken");
        keys.breakKey(broken);
        keys.createUnusable = true;
        check(setFails("naiToken", "pst-new"), "a write that could not be sealed resolved");
        keys.createUnusable = false;
        check(aliasOf("naiToken").equals(broken), "the stored value changed after a failed write");
        check(keys.keys.keySet().equals(Set.of(broken)), "keys left: " + keys.keys.keySet());
        prefs.relaunch();
        check(prefs.get("naiToken") != null, "value deleted after a failed write");
        check(!setFails("naiToken", "pst-new"), "a later write failed");
        expectRead("naiToken", "pst-new", "naiToken after a later write");
        check(keys.keys.size() == 1, "keys left: " + keys.keys.keySet());
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
                case "unusableKeyIsReplacedOnWrite": t.unusableKeyIsReplacedOnWrite(); break;
                case "unreadableKeyIsReplacedOnWrite": t.unreadableKeyIsReplacedOnWrite(); break;
                case "failedWriteOverUnusableKeyKeepsBothKeys": t.failedWriteOverUnusableKeyKeepsBothKeys(); break;
                case "freshKeyThatCannotSealIsDropped": t.freshKeyThatCannotSealIsDropped(); break;
                default: throw new AssertionError("unknown scenario " + args[0]);
            }
        } catch (AssertionError e) {
            System.out.println("FAIL " + args[0] + ": " + e.getMessage());
            System.exit(1);
        }
        System.out.println("ok " + args[0]);
    }
}
