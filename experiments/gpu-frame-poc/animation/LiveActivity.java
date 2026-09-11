package dev.expo.gpupoc;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;

/** Interactive fixture for the complete Device Hub loop; benchmark activity is unchanged. */
public class LiveActivity extends Activity {
  boolean animate = true;
  int taps = 0;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(20, 40, 20, 20);
    root.setOnApplyWindowInsetsListener((view, insets) -> {
      android.graphics.Insets safe = insets.getInsets(
        android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
      view.setPadding(20, safe.top + 20, 20, safe.bottom + 20);
      return insets;
    });
    TextView title = new TextView(this);
    title.setText("GPU → NVENC → Device Hub"); title.setTextSize(22);
    root.addView(title);
    EditText text = new EditText(this);
    text.setSingleLine(true); text.setHint("Type through Device Hub");
    root.addView(text);
    Button count = new Button(this);
    count.setText("Taps: 0");
    count.setOnClickListener(v -> count.setText("Taps: " + (++taps)));
    root.addView(count);
    View motion = new View(this) {
      final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
      long frame = 0;
      @Override protected void onDraw(Canvas canvas) {
        canvas.drawColor(Color.rgb(16, 24, 40));
        paint.setColor(Color.GREEN);
        float x = (frame * 7) % Math.max(1, getWidth());
        canvas.drawRect(x, 70, x + 60, 140, paint);
        paint.setColor(Color.WHITE); paint.setTextSize(30);
        canvas.drawText("FRAME " + frame + (animate ? " / live" : " / paused"), 12, 45, paint);
        if (animate) { frame++; postInvalidateOnAnimation(); }
      }
    };
    root.addView(motion, new LinearLayout.LayoutParams(-1, 180));
    Button pause = new Button(this);
    pause.setText("Pause animation");
    pause.setOnClickListener(v -> {
      animate = !animate;
      pause.setText(animate ? "Pause animation" : "Resume animation");
      motion.invalidate();
    });
    root.addView(pause);
    ScrollView scroll = new ScrollView(this);
    LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
    for (int i = 1; i <= 30; i++) {
      TextView row = new TextView(this);
      row.setText("Swipe test — row " + i); row.setTextSize(20); row.setPadding(12, 18, 12, 18);
      rows.addView(row);
    }
    scroll.addView(rows); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
  }
}
