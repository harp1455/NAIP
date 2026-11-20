package io.github.harp1455.naip;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

/**
 * 웹뷰에서 할 수 없는 일을 맡는다 (src/lib/native.ts 와 짝):
 * - saveToGallery: MediaStore로 Pictures/NAIP[/하위폴더] 에 저장 (Android 10+ 는 권한 불필요)
 * - setKeepAwake: 대량 생성 중 화면 꺼짐 방지
 * - startJob / updateJob / stopJob: 백그라운드 생성용 포그라운드 서비스와 진행·완료 알림
 */
@CapacitorPlugin(name = "NaipNative")
public class NaipNativePlugin extends Plugin {

    private boolean inForeground = true;
    private boolean jobRunning = false;

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
    public void setKeepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity()
            .runOnUiThread(() -> {
                if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                call.resolve();
            });
    }
}
