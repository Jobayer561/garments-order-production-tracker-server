require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
//   "utf-8"
// );
// const serviceAccount = JSON.parse(decoded);
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
// const verifyJWT = async (req, res, next) => {
//   const token = req?.headers?.authorization?.split(" ")[1];
//   console.log(token);
//   if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
//   try {
//     const decoded = await admin.auth().verifyIdToken(token);
//     req.tokenEmail = decoded.email;
//     console.log(decoded);
//     next();
//   } catch (err) {
//     console.log(err);
//     return res.status(401).send({ message: "Unauthorized Access!", err });
//   }
// };

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("garments-tracker");
    const usersCollection = db.collection("users");
    const productsCollection = db.collection("products");

    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.status = "pending";
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      const query = {
        email: userData.email,
      };
      const alreadyExist = await usersCollection.findOne(query);
      if (alreadyExist) {
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });
    app.get("/user/role", async (req, res) => {
      const email = req.query.email;
      const result = await usersCollection.findOne({ email: email });
      res.send({ role: result?.role });
    });
    app.get("/products", async (req, res) => {
      const result = await productsCollection
        .find({ showOnHomePage: true })
        .sort({ created_at: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    });

    app.get("/allProducts", async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });
    app.post("/allProducts", async (req, res) => {
      const productData = req.body;

      productData.created_at = new Date();

      console.log(productData);

      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });
    app.get("/allProducts/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log("PAYMENT INFO 👉", paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.title,
                description: paymentInfo?.description,
                images: paymentInfo?.images || [],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          productId: paymentInfo?.productId,
          customer: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/plant/${paymentInfo?.productId}`,
      });

      res.send({ url: session.url });
    });
       
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
