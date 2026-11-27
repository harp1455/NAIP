package io.github.harp1455.naip;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 웹뷰에서 할 수 없는 일을 맡는다 (src/lib/native.ts 와 짝):
 * - saveToGallery: MediaStore로 Pictures/NAIP[/하위폴더] 에 저장 (Android 10+ 는 권한 불필요)
 *   (Phase 5) path로 여러 단계 하위 폴더, overwrite로 이 앱이 만든 같은 파일을 덮어쓰기
 * - saveTextFile (Phase 5): 글 파일(내보내기 목록)을 Download/NAIP[/하위폴더] 에 저장
 *   — 안드로이드는 Pictures 아래에 사진이 아닌 파일을 넣지 못하게 하므로 다운로드 모음(MediaStore.Downloads)을 쓴다
 * - listSaved (Phase 5): 이 앱이 Pictures/NAIP 아래에 저장한 파일 경로 (내보내기 충돌 미리보기용)
 * - setKeepAwake: 대량 생성 중 화면 꺼짐 방지
 * - httpGet / installUpdate: GitHub 릴리스에서 새 APK를 확인·다운로드하고 설치 화면을 띄운다
 * - delay: 백그라운드에서도 늦어지지 않는 타이머 (장 사이 간격)
 * - copyImage: 이미지를 캐시에 쓰고 그 content:// 주소를 클립보드에 올린다 (메신저에 바로 붙여 넣기)
 * - haptic: 꾹 눌렀을 때의 짧은 진동
 * - readClipboard: 프롬프트 칸의 붙여넣기 버튼 (웹뷰는 클립보드 읽기 권한이 없음)
 * - startJob / updateJob / stopJob: 백그라운드 생성용 포그라운드 서비스와 진행·완료 알림
 */
@CapacitorPlugin(name = "NaipNative")
public class NaipNativePlugin extends Plugin {

    private boolean inForeground = true;
    private boolean jobRunning = false;
    /** 알림의 "중지" 단추가 웹뷰에 알릴 수 있도록 살아 있는 플러그인을 기억해 둔다 */
    private static NaipNativePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** 알림에서 "중지"를 눌렀을 때 — 웹뷰로 stopRequested 이벤트를 보낸다. 받을 곳이 없으면 false */
    static boolean requestStop() {
        NaipNativePlugin plugin = instance;
        if (plugin == null || !plugin.jobRunning) return false;
        plugin.notifyListeners("stopRequested", new JSObject());
        return true;
    }

    @Override
    protected void handleOnResume() {
        inForeground = true;
        // 앱으로 돌아오면 완료 알림은 더 필요 없다
        getContext().getSystemService(NotificationManager.class).cancel(GenerationService.ID_DONE);
    }

    @Override
    protected void handleOnPause() {
        inForeground = false;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        getContext().stopService(new Intent(getContext(), GenerationService.class));
    }

    private boolean canNotify() {
        return (
            Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        );
    }

    @PluginMethod
    public void startJob(PluginCall call) {
        if (!canNotify()) {
            // 알림을 거부해도 서비스는 돈다 (알림만 안 보임). 한 번 물어본다.
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7001);
        }
        try {
            Intent intent = new Intent(getContext(), GenerationService.class);
            intent.putExtra(GenerationService.EXTRA_TEXT, call.getString("text", ""));
            ContextCompat.startForegroundService(getContext(), intent);
            jobRunning = true;
            call.resolve();
        } catch (Exception e) {
            call.reject("foreground service failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void updateJob(PluginCall call) {
        if (jobRunning && canNotify()) {
            getContext()
                .getSystemService(NotificationManager.class)
                .notify(
                    GenerationService.ID_PROGRESS,
                    GenerationService.progressNotification(
                        getContext(),
                        call.getString("text", ""),
                        call.getInt("done", 0),
                        call.getInt("total", 0)
                    )
                );
        }
        call.resolve();
    }

    @PluginMethod
    public void stopJob(PluginCall call) {
        jobRunning = false;
        getContext().stopService(new Intent(getContext(), GenerationService.class));
        String text = call.getString("text");
        if (text != null && !inForeground && canNotify()) {
            GenerationService.createChannels(getContext());
            getContext()
                .getSystemService(NotificationManager.class)
                .notify(GenerationService.ID_DONE, GenerationService.doneNotification(getContext(), text));
        }
        if (Boolean.TRUE.equals(call.getBoolean("vibrate", false))) {
            Vibrator vibrator = getContext().getSystemService(Vibrator.class);
            if (vibrator != null) vibrator.vibrate(VibrationEffect.createOneShot(250, VibrationEffect.DEFAULT_AMPLITUDE));
        }
        call.resolve();
    }

    @PluginMethod
    public void saveToGallery(PluginCall call) {
        String base64 = call.getString("base64");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "image/png");
        String folder = call.getString("folder");
        // ── Phase 5: path = "a/b" 여러 단계 하위 폴더 (단계마다 정리), overwrite = 이 앱이 만든 같은 파일을 새로 씀
        String path = call.getString("path");
        boolean overwrite = Boolean.TRUE.equals(call.getBoolean("overwrite", false));
        if (base64 == null || fileName == null) {
            call.reject("base64 and fileName are required");
            return;
        }
        String sub = path != null ? cleanPath(path) : (folder != null ? folder : "");
        String relative = Environment.DIRECTORY_PICTURES + "/NAIP" + (sub.isEmpty() ? "" : "/" + sub);
        try {
            JSObject result = writeMedia(
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                relative,
                path != null ? cleanSegment(fileName) : fileName,
                mimeType,
                Base64.decode(base64, Base64.DEFAULT),
                overwrite
            );
            call.resolve(result);
        } catch (OverwriteDenied e) {
            call.reject(e.getMessage(), "OVERWRITE_DENIED", e);
        } catch (Exception e) {
            call.reject("save failed: " + e.getMessage(), e);
        }
    }

    // ── Phase 5: 내보내기 저장 도우미 ─────────────────────────────────────────

    /** 덮어쓰기를 바랐지만 같은 이름의 파일이 이 앱 것이 아니라(다른 앱·앱 재설치) 덮어쓸 수 없을 때 */
    static class OverwriteDenied extends Exception {
        OverwriteDenied(String msg) {
            super(msg);
        }
    }

    private static final java.util.regex.Pattern FORBIDDEN = java.util.regex.Pattern.compile("[\\\\/:*?\"<>|\\u0000-\\u001f]");
    private static final java.util.regex.Pattern EDGES = java.util.regex.Pattern.compile("^[.\\s]+|[.\\s]+$");

    /** 파일·폴더 이름 한 단계 정리 — src/lib/native.ts cleanFileName과 같은 규칙 (금지 문자 → _, 앞뒤 점·공백, 80자). 비면 "" */
    static String cleanSegment(String name) {
        if (name == null) return "";
        String s = EDGES.matcher(FORBIDDEN.matcher(name).replaceAll("_")).replaceAll("");
        if (s.codePointCount(0, s.length()) > 80) s = EDGES.matcher(s.substring(0, s.offsetByCodePoints(0, 80))).replaceAll("");
        return s;
    }

    /** "a/b/c" → 단계마다 정리하고 빈 단계(.. 포함)는 뺀다 */
    static String cleanPath(String path) {
        StringBuilder out = new StringBuilder();
        for (String seg : path.split("/")) {
            String c = cleanSegment(seg);
            if (c.isEmpty()) continue;
            if (out.length() > 0) out.append('/');
            out.append(c);
        }
        return out.toString();
    }

    /** 이 앱이 만든 (relative 폴더, 이름) 항목 — 이름은 대소문자 무시. 없으면 null (권한 없이 보이는 것은 이 앱 것뿐) */
    private Uri findOwn(ContentResolver resolver, Uri collection, String relative, String fileName) {
        String rel = relative.endsWith("/") ? relative : relative + "/";
        try (
            Cursor c = resolver.query(
                collection,
                new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME },
                MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                new String[] { rel },
                null
            )
        ) {
            if (c == null) return null;
            while (c.moveToNext()) {
                if (fileName.equalsIgnoreCase(c.getString(1))) return ContentUris.withAppendedId(collection, c.getLong(0));
            }
        }
        return null;
    }

    private static String queryName(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // 이름을 못 읽으면 바란 이름으로 본다
        }
        return null;
    }

    private static JSObject savedResult(Uri uri, String rel, String root, String name, boolean overwritten, boolean renamed) {
        JSObject r = new JSObject();
        r.put("uri", uri.toString());
        r.put("name", name);
        r.put("path", rel.substring(root.length()) + name);
        r.put("overwritten", overwritten);
        r.put("renamed", renamed);
        return r;
    }

    /**
     * MediaStore에 쓴다. overwrite면 이 앱이 만든 같은 항목을 새로 쓰고(교체한 새 버전), 없으면 새로 만든다.
     * 새로 만들 때 같은 이름이 이미 있으면(이 앱 것이 아님) MediaStore가 "이름 (1)"로 바꾸는데 —
     * overwrite를 바랐으면 몰래 다른 이름으로 두지 않고 지운 뒤 OverwriteDenied, 아니면 바뀐 이름을 돌려준다(renamed).
     */
    private JSObject writeMedia(Uri collection, String relative, String fileName, String mimeType, byte[] data, boolean overwrite)
        throws Exception {
        if (fileName.isEmpty()) throw new IllegalArgumentException("empty file name");
        ContentResolver resolver = getContext().getContentResolver();
        String rel = relative.endsWith("/") ? relative : relative + "/";
        String pictures = Environment.DIRECTORY_PICTURES + "/NAIP/";
        String downloads = Environment.DIRECTORY_DOWNLOADS + "/NAIP/";
        String root = rel.startsWith(pictures) ? pictures : rel.startsWith(downloads) ? downloads : "";
        if (overwrite) {
            Uri existing = findOwn(resolver, collection, rel, fileName);
            if (existing != null) {
                ContentValues pending = new ContentValues();
                pending.put(MediaStore.MediaColumns.IS_PENDING, 1);
                try {
                    resolver.update(existing, pending, null, null);
                } catch (Exception ignored) {
                    // 일부 기기는 이미 공개된 항목의 IS_PENDING을 바꾸지 못한다 — 그대로 쓴다
                }
                try (OutputStream out = resolver.openOutputStream(existing, "wt")) {
                    if (out == null) throw new IllegalStateException("cannot open output stream");
                    out.write(data);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                done.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                try {
                    resolver.update(existing, done, null, null);
                } catch (Exception ignored) {
                    // 내용은 이미 썼다
                }
                String actual = queryName(resolver, existing);
                return savedResult(existing, rel, root, actual != null ? actual : fileName, true, false);
            }
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relative);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IllegalStateException("MediaStore insert failed");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("cannot open output stream");
            out.write(data);
        } catch (Exception e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        String actual = queryName(resolver, uri);
        boolean renamed = actual != null && !actual.equals(fileName);
        if (overwrite && renamed) {
            resolver.delete(uri, null, null);
            throw new OverwriteDenied("cannot overwrite " + fileName + ": the existing file belongs to another app or an earlier install");
        }
        return savedResult(uri, rel, root, actual != null ? actual : fileName, false, renamed);
    }

    /** ── Phase 5: 글 파일(내보내기 목록 CSV·JSON·TXT·MD)을 Download/NAIP[/path] 에 UTF-8로 저장 */
    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String text = call.getString("text");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "text/plain");
        String path = call.getString("path", "");
        boolean overwrite = Boolean.TRUE.equals(call.getBoolean("overwrite", false));
        if (text == null || fileName == null) {
            call.reject("text and fileName are required");
            return;
        }
        String sub = cleanPath(path);
        String relative = Environment.DIRECTORY_DOWNLOADS + "/NAIP" + (sub.isEmpty() ? "" : "/" + sub);
        try {
            call.resolve(
                writeMedia(
                    MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                    relative,
                    cleanSegment(fileName),
                    mimeType,
                    text.getBytes(StandardCharsets.UTF_8),
                    overwrite
                )
            );
        } catch (OverwriteDenied e) {
            call.reject(e.getMessage(), "OVERWRITE_DENIED", e);
        } catch (Exception e) {
            call.reject("save failed: " + e.getMessage(), e);
        }
    }

    /** ── Phase 5: 이 앱이 Pictures/NAIP[/path] 아래에 저장한 파일의 상대 경로 (권한 없이 보이는 것은 이 앱 것뿐) */
    @PluginMethod
    public void listSaved(PluginCall call) {
        String sub = cleanPath(call.getString("path", ""));
        String root = Environment.DIRECTORY_PICTURES + "/NAIP/";
        String prefix = root + (sub.isEmpty() ? "" : sub + "/");
        JSArray paths = new JSArray();
        try (
            Cursor c = getContext()
                .getContentResolver()
                .query(
                    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
                    new String[] { MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DISPLAY_NAME },
                    MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                    new String[] { root + "%" },
                    null
                )
        ) {
            while (c != null && c.moveToNext()) {
                String rel = c.getString(0);
                String name = c.getString(1);
                if (rel == null || name == null) continue;
                if (!rel.endsWith("/")) rel = rel + "/";
                // LIKE의 _ 는 한 글자 와일드카드라 앞부분을 다시 확인한다
                if (!rel.regionMatches(true, 0, prefix, 0, prefix.length())) continue;
                paths.put(rel.substring(root.length()) + name);
            }
            JSObject result = new JSObject();
            result.put("paths", paths);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("list failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void copyImage(PluginCall call) {
        String base64 = call.getString("base64");
        String mimeType = call.getString("mimeType", "image/png");
        if (base64 == null) {
            call.reject("base64 is required");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "clipboard");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create cache dir");
            // 이전에 복사한 파일은 지운다 (붙여 넣는 앱이 읽는 중일 수 있어 가장 최근 것은 남긴다)
            File[] old = dir.listFiles();
            if (old != null && old.length > 1) {
                java.util.Arrays.sort(old, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                for (int i = 1; i < old.length; i++) old[i].delete();
            }
            String ext = "image/webp".equals(mimeType) ? ".webp" : ".png";
            File file = new File(dir, "NAIP_" + System.currentTimeMillis() + ext);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            ClipData clip = ClipData.newUri(getContext().getContentResolver(), "NAIP image", uri);
            ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
            if (clipboard == null) throw new IllegalStateException("clipboard unavailable");
            // 시스템이 붙여 넣는 앱에 이 주소를 읽을 권한을 넘겨준다 (FileProvider grantUriPermissions)
            clipboard.setPrimaryClip(clip);
            call.resolve();
        } catch (Exception e) {
            call.reject("copy failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void copyText(PluginCall call) {
        ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
        if (clipboard == null) {
            call.reject("clipboard unavailable");
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText(call.getString("label", "NAIP"), call.getString("text", "")));
        call.resolve();
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        getActivity()
            .runOnUiThread(() -> {
                getBridge().getWebView().performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                call.resolve();
            });
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
        ClipData clip = clipboard != null ? clipboard.getPrimaryClip() : null;
        CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(getContext()) : null;
        JSObject result = new JSObject();
        result.put("text", text != null ? text.toString() : "");
        call.resolve(result);
    }

    /** 웹뷰가 화면에 없으면 JS 타이머가 크게 늦어지므로, 장 사이 대기는 여기서 센다 */
    @PluginMethod
    public void delay(PluginCall call) {
        int ms = Math.max(0, call.getInt("ms", 0));
        new Handler(Looper.getMainLooper()).postDelayed(() -> call.resolve(), ms);
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity()
            .runOnUiThread(() -> {
                if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                call.resolve();
            });
    }

    private static HttpURLConnection open(String url, String accept, String token) throws Exception {
        if (!url.startsWith("https://")) throw new IllegalArgumentException("https only");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", accept);
        c.setRequestProperty("User-Agent", "NAIP-updater");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    /** 업데이트 확인용 GET (웹뷰의 CORS·권한과 무관하게 동작하도록 네이티브로 요청) */
    @PluginMethod
    public void httpGet(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token");
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = open(url, "application/vnd.github+json", token);
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] chunk = new byte[8192];
                    for (int n; (n = in.read(chunk)) > 0;) buf.write(chunk, 0, n);
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", new String(buf.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(result);
            } catch (Exception e) {
                call.reject("request failed: " + e.getMessage(), e);
            } finally {
                if (c != null) c.disconnect();
            }
        })
            .start();
    }

    /** 새 APK를 캐시에 내려받아(진행률은 updateProgress 이벤트) 시스템 설치 화면을 띄운다 */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token");
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create cache dir");
                File apk = new File(dir, "NAIP-update.apk");

                String current = url;
                int status = 0;
                for (int hop = 0; hop < 6; hop++) {
                    // 토큰은 처음 요청(GitHub)에만 — 리다이렉트된 저장소 주소로는 보내지 않는다
                    c = open(current, "application/octet-stream", hop == 0 ? token : null);
                    status = c.getResponseCode();
                    if (status < 300 || status >= 400) break;
                    current = c.getHeaderField("Location");
                    c.disconnect();
                    c = null;
                    if (current == null) throw new IllegalStateException("redirect without location");
                }
                if (c == null || status != 200) throw new IllegalStateException("download failed (" + status + ")");

                long total = c.getContentLengthLong();
                long received = 0;
                long lastNotified = 0;
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] chunk = new byte[65536];
                    for (int n; (n = in.read(chunk)) > 0;) {
                        out.write(chunk, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotified > 150) {
                            lastNotified = now;
                            JSObject progress = new JSObject();
                            progress.put("received", received);
                            progress.put("total", total);
                            notifyListeners("updateProgress", progress);
                        }
                    }
                }

                // 받은 파일이 정말 이 앱의 APK인지 확인하고 나서 설치 화면으로 넘긴다
                PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                if (info == null || !getContext().getPackageName().equals(info.packageName)) {
                    apk.delete();
                    throw new IllegalStateException("downloaded file is not a NAIP package");
                }

                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(install);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            } finally {
                if (c != null) c.disconnect();
            }
        })
            .start();
    }
}
