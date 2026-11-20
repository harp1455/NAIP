package io.github.harp1455.naip;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NaipNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
