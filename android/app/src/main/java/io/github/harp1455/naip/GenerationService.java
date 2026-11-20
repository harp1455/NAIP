package io.github.harp1455.naip;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * 대량 생성 중 앱이 뒤로 가도 프로세스와 네트워크가 살아 있도록 하는 포그라운드 서비스.
 * 실제 생성은 웹뷰의 JS가 하고, 이 서비스는 진행 알림과 wake lock만 쥔다.
 */
public class GenerationService extends Service {

    static final String CHANNEL_PROGRESS = "naip_progress";
    static final String CHANNEL_DONE = "naip_done";
    static final int ID_PROGRESS = 1;
    static final int ID_DONE = 2;
    static final String EXTRA_TEXT = "text";
    /** 한 배치가 이보다 오래 걸리면 wake lock은 풀린다 (서비스는 유지) */
    private static final long WAKE_LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000;

    private PowerManager.WakeLock wakeLock;

    static void createChannels(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        NotificationChannel progress = new NotificationChannel(CHANNEL_PROGRESS, "생성 진행", NotificationManager.IMPORTANCE_LOW);
        progress.setShowBadge(false);
        nm.createNotificationChannel(progress);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_DONE, "생성 완료", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Notification progressNotification(Context context, String text, int done, int total) {
        return new NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_naip)
            .setContentTitle("NAIP 생성 중")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(total, done, total <= 0)
            .setContentIntent(openApp(context))
            .build();
    }

    static Notification doneNotification(Context context, String text) {
        return new NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_stat_naip)
            .setContentTitle("NAIP")
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openApp(context))
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels(this);
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification n = progressNotification(this, text != null ? text : "", 0, 0);
        startForeground(ID_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "naip:generation");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
