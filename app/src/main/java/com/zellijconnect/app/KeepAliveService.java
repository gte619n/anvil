package com.zellijconnect.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;

public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "zellij_sessions";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_UPDATE = "com.zellijconnect.app.UPDATE_NOTIFICATION";
    private static final String EXTRA_TAB_COUNT = "tab_count";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int tabCount = 1;
        if (intent != null) {
            tabCount = intent.getIntExtra(EXTRA_TAB_COUNT, 1);
        }

        Notification notification = buildNotification(tabCount);
        startForeground(NOTIFICATION_ID, notification);

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.notification_channel_description));
        channel.setShowBadge(false);
        channel.enableLights(false);
        channel.enableVibration(false);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(int tabCount) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setAction(Intent.ACTION_MAIN);
        launchIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE
        );

        String contentText = tabCount + " active tab" + (tabCount != 1 ? "s" : "") + " - Connected";

        return new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Anvil")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }

    public static void start(Context context, int tabCount) {
        Intent intent = new Intent(context, KeepAliveService.class);
        intent.putExtra(EXTRA_TAB_COUNT, tabCount);
        context.startForegroundService(intent);
    }

    public static void updateTabCount(Context context, int tabCount) {
        start(context, tabCount); // Re-starting updates the notification
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, KeepAliveService.class));
    }
}
