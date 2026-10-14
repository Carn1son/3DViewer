import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { LWOLoader } from 'three/examples/jsm/loaders/LWOLoader.js';
import { KMZLoader } from 'three/examples/jsm/loaders/KMZLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import * as fflate from 'three/examples/jsm/libs/fflate.module.js';
const THREE = Object.assign({}, T, { OrbitControls, TransformControls, RoomEnvironment, BufferGeometryUtils,
  GLTFLoader, OBJLoader, MTLLoader, STLLoader, PLYLoader, FBXLoader, ColladaLoader, TDSLoader, ThreeMFLoader, AMFLoader,
  VRMLLoader, VTKLoader, PCDLoader, XYZLoader, USDZLoader, LWOLoader, KMZLoader,
  GLTFExporter, OBJExporter, STLExporter, PLYExporter, USDZExporter, fflate });
window.THREE = THREE;
