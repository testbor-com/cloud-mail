
import * as echarts from 'echarts/core';

import { BarChart,PieChart,LineChart,GaugeChart} from 'echarts/charts';
// Import title, tooltip, Cartesian coordinates, dataset, and built-in data transform components; each has a Component suffix
import {
    TooltipComponent,
    GridComponent,
} from 'echarts/components';
// Features such as automatic label layout and universal transitions
// Import the Canvas renderer; either CanvasRenderer or SVGRenderer is required
import { CanvasRenderer } from 'echarts/renderers';
import { LegendComponent } from 'echarts/components';
// Register the required components
echarts.use([
    GaugeChart,
    LegendComponent,
    PieChart,
    TooltipComponent,
    GridComponent,
    BarChart,
    LineChart,
    CanvasRenderer
]);

export default echarts