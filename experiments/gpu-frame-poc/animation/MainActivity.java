package dev.expo.gpupoc;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;
import android.view.WindowManager;

public class MainActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    WindowManager.LayoutParams p=getWindow().getAttributes();
    p.preferredRefreshRate=120;getWindow().setAttributes(p);
    setContentView(new View(this){
      final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
      long frame=0;
      @Override protected void onDraw(Canvas c){
        int w=getWidth(),h=getHeight();frame++;
        c.drawColor(Color.rgb(16,24,40));
        paint.setColor(Color.RED);c.drawRect(0,0,w,h/8f,paint);
        paint.setColor(Color.BLUE);c.drawRect(0,h*7/8f,w,h,paint);
        paint.setColor(Color.GREEN);float x=(frame*13)%(w+160)-160;
        c.drawRect(x,h/3f,x+160,h*2/3f,paint);
        paint.setColor(Color.WHITE);paint.setTextSize(w/16f);
        c.drawText("TOP / RED",24,h/12f,paint);
        c.drawText("FRAME "+frame,24,h/4f,paint);
        c.drawText("BOTTOM / BLUE",24,h*15/16f,paint);
        for(int i=0;i<16;i++){
          paint.setColor(((frame>>i)&1)!=0?Color.WHITE:Color.BLACK);
          c.drawRect(i*w/16f,h*3/4f,(i+1)*w/16f,h*13/16f,paint);
        }
        postInvalidateOnAnimation();
      }
    });
  }
}
