package io.github.harp1455.naip;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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
        if (base64 == null || fileName == null) {
            call.reject("base64 and fileName are required");
            return;
        }

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/NAIP" + (folder != null && !folder.isEmpty() ? "/" + folder : ""));
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (uri == null) {
            call.reject("MediaStore insert failed");
            return;
        }
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IllegalStateException("cannot open output stream");
            out.write(Base64.decode(base64, Base64.DEFAULT));
        } catch (Exception e) {
            resolver.delete(uri, null, null);
            call.reject("save failed: " + e.getMessage(), e);
            return;
        }
        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);

        JSObject result = new JSObject();
        result.put("uri", uri.toString());
        call.resolve(result);
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
