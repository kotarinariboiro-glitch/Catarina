import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyAbAvCI9jwKzAdqxp7TBsPRKo2seIg2CSk",
    authDomain: "wedding-checkin-be0f5.firebaseapp.com",
    projectId: "wedding-checkin-be0f5",
    storageBucket: "wedding-checkin-be0f5.firebasestorage.app",
    messagingSenderId: "143671596549",
    appId: "1:143671596549:web:36ded6bacd8b68e5a66e6c"
  };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
