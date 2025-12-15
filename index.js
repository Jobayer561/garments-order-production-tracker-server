require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

// const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
//   "utf-8"
// );
// const serviceAccount = JSON.parse(decoded);
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });
function generateTrackingId() {
  const prefix = "ORD";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}
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
    const ordersCollection = db.collection("orders");
    const trackingsCollection = db.collection("trackings");
    const logOrderTracking = async (
      trackingId,
      status,
      location = "",
      note = ""
    ) => {
      const log = {
        trackingId,
        status,
        location,
        note,
        createdAt: new Date(),
      };
      return await trackingsCollection.insertOne(log);
    };
    app.get("/user", async (req, res) => {
      const { searchText, role } = req.query;
      const query = {};
      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      if (role) {
        query.role = role;
      }

      const result = await usersCollection
        .find(query)
        .sort({ created_at: -1 })
        .toArray();

      res.send(result);
    });
    app.get("/profile", async (req, res) => {
      const query = {};
      const { email } = req.query;

      const result = await usersCollection.findOne({ email });
      console.log(result);
      res.json(result);
    });

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
    app.patch("/update-status", async (req, res) => {
      const { email, status, reason, feedback } = req.body;

      const updateDoc = {
        status,
      };
      if (status === "suspend") {
        updateDoc.reason = reason || "";
        updateDoc.feedback = feedback || "";
      } else {
        updateDoc.reason = "";
        updateDoc.feedback = "";
      }
      const result = await usersCollection.updateOne(
        { email },
        { $set: updateDoc }
      );
      if (result.modifiedCount) {
        res.send({ message: "User status updated successfully" });
      } else {
        res.status(400).send({ message: "No changes were made" });
      }
    });

    app.get("/products", async (req, res) => {
      const result = await productsCollection
        .find({ showOnHomePage: true })
        .sort({ created_at: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    });
    app.patch("/products/:id/home", async (req, res) => {
      const { id } = req.params;
      console.log("PARAM ID:", req.params.id);

      const { showOnHomePage } = req.body;

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { showOnHomePage } }
      );

      res.send(result);
    });
    app.delete("/products/:id", async (req, res) => {
      const { id } = req.params;
      console.log(id);
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });
    app.patch("/products/:id", async (req, res) => {
      const { id } = req.params;
      const updatedData = req.body;

      updatedData.updated_at = new Date();

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updatedData,
        }
      );

      res.send(result);
    });

    app.get("/allProducts", async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });
    app.post("/allProducts", async (req, res) => {
      const productData = req.body;
      productData.created_By = productData.email;
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
      console.log("PayMent Info", paymentInfo);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: Math.round(Number(paymentInfo.price) * 100),
              product_data: {
                name: paymentInfo.title,
                images: paymentInfo.images?.slice(0, 1) || [],
              },
            },
            quantity: Number(paymentInfo.quantity),
          },
        ],
        customer_email: paymentInfo.Buyer.email,

        mode: "payment",
        metadata: {
          productId: paymentInfo.productId,
          productName: paymentInfo.title,
          BuyerName: paymentInfo.Buyer.name,
          BuyerEmail: paymentInfo.Buyer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancel`,
      });
      console.log("hello from session", session);
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      console.log("from sessionId", sessionId);

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("Stripe session metadata:", session.metadata);

      const product = await productsCollection.findOne({
        _id: new ObjectId(session.metadata.productId),
      });

      if (!product)
        return res.status(404).send({ message: "Product not found" });

      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      const trackingId = generateTrackingId();

      if (session.status === "complete" && !order) {
        const orderInfo = {
          productId: product._id,
          trackingId: trackingId,
          transactionId: session.payment_intent,

          Buyer: {
            name: session.metadata.BuyerName,
            email: session.metadata.BuyerEmail,
          },

          product: {
            name: product.title,
            category: product.category,
            image: product.images?.[0] || "",
            price: product.price,
          },

          quantity: 1,
          totalPrice: session.amount_total / 100,
          paymentMethod: "PayFirst",
          status: "pending",
          approvedBy: null,
          approvedAt: null,
          rejectedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await ordersCollection.insertOne(orderInfo);

        await productsCollection.updateOne(
          { _id: product._id },
          { $inc: { availableQuantity: -1 } }
        );

        await logOrderTracking(trackingId, "Order Created");

        return res.send({
          success: true,
          orderId: result.insertedId,
          trackingId,
          transactionId: session.payment_intent,
        });
      }

      return res.send({
        success: false,
        message: "Order already exists or payment not complete",
        transactionId: session.payment_intent,
        trackingId,
      });
    });


    // app.post("/payment-success", async (req, res) => {
    //   const { sessionId } = req.body;
    //   const session = await stripe.checkout.sessions.retrieve(sessionId);
    //   const product = await productsCollection.findOne({
    //     _id: new ObjectId(session.metadata.plantId),
    //   });

    //   const order = await ordersCollection.findOne({
    //     transactionId: session.payment_intent,
    //   });
    //   if (session.status === "complete" && product && !order) {
    //     //save order data in db
    //     const orderInfo = {
    //       productId: session.metadata.plantId,
    //       transactionId: session.payment_intent,
    //       Buyer: session.metadata.Buyer,
    //       status: "pending",
    //       seller: product.seller,
    //       name: plant.name,
    //       category: plant.category,
    //       quantity: 1,
    //       price: session.amount_total / 100,
    //       image: plant?.image,
    //     };
    //     console.log(orderInfo);
    //     // const result = await ordersCollection.insertOne(orderInfo);
    //     // // update plant quantity
    //     // await plantsCollection.updateOne(
    //     //   {
    //     //     _id: new ObjectId(session.metadata.plantId),
    //     //   },
    //     //   { $inc: { quantity: -1 } }
    //     // );

    //     // return res.send({
    //     //   transactionId: session.payment_intent,
    //     //   orderId: result.insertedId,
    //     // });
    //   }
    //   // res.send(
    //   //   res.send({
    //   //     transactionId: session.payment_intent,
    //   //     orderId: order._id,
    //   //   })
    //   // );
    // });
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
